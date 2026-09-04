#include "common.h"
#include "ggml-backend.h"
#include "llama.h"
#include "../../src/llama-ext.h"

extern "C" {
#include "hash/sha256/sha256.h"
}

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <process.h>
#else
#include <unistd.h>
#endif

namespace {

constexpr int32_t  EXPECTED_N_EMBD            = 2560;
constexpr int32_t  EXPECTED_N_EMBD_OUT        = 10240;
constexpr int32_t  EXPECTED_N_LAYER           = 48;
constexpr int32_t  DEFAULT_PROPOSALS          = 3;
constexpr int32_t  DEFAULT_PREFIX             = 4;
constexpr int32_t  DEFAULT_WARMUPS            = 3;
constexpr int32_t  DEFAULT_BARRIER_TIMEOUT_MS = 120000;
constexpr uint64_t DEFAULT_MIN_PARAMS         = 150000000000ULL;
constexpr uint64_t DEFAULT_MAX_PARAMS         = 200000000000ULL;
constexpr uint64_t DEFAULT_MIN_BYTES          = 80ULL * 1024 * 1024 * 1024;
constexpr uint64_t DEFAULT_MAX_BYTES          = 130ULL * 1024 * 1024 * 1024;
constexpr uint64_t SEED                       = 0x5441524745545652ULL;

using clock_type = std::chrono::steady_clock;

struct options {
    std::string model;
    int32_t seqs         = 4;
    int32_t rounds       = 20;
    int32_t warmups      = DEFAULT_WARMUPS;
    int32_t prefix_tokens = DEFAULT_PREFIX;
    int32_t proposals    = DEFAULT_PROPOSALS;
    int32_t n_ctx        = 8192;
    int32_t gpu_layers   = -1;
    uint64_t min_model_params = DEFAULT_MIN_PARAMS;
    uint64_t max_model_params = DEFAULT_MAX_PARAMS;
    uint64_t min_model_bytes  = DEFAULT_MIN_BYTES;
    uint64_t max_model_bytes  = DEFAULT_MAX_BYTES;
    std::string ready_file;
    std::string start_file;
    int32_t barrier_timeout_ms = DEFAULT_BARRIER_TIMEOUT_MS;
    bool allow_cpu             = false;
    bool accept_all_capacity   = false;
};

struct token_fixture {
    std::vector<llama_token> prefix;
    std::vector<llama_token> current;
    std::vector<llama_token> proposals;
};

void print_usage(const char * argv0) {
    std::printf(
            "Usage: %s --model MODEL --accept-all-capacity [options]\n"
            "\n"
            "Benchmark full-target verification of prefetched Qwen4Exp proposals.\n"
            "This is a prefetched-proposal verifier upper bound, not an end-to-end speculative benchmark.\n"
            "\n"
            "Options:\n"
            "  --model PATH             full Qwen4Exp target GGUF (required)\n"
            "  --seqs N                 parallel sequences (default: 4)\n"
            "  --rounds N               measured verification batches (default: 20)\n"
            "  --warmups N              untimed batches, at least 3 (default: 3)\n"
            "  --prefix-tokens N        retained untimed prefix per sequence, at least 1 (default: 4)\n"
            "  --proposals N            prefetched proposals per sequence; 1 or 3 (default: 3)\n"
            "  --ctx N                  total context size (default: 8192)\n"
            "  --gpu-layers N           layers to offload, -1 means all (default: -1)\n"
            "  --accept-all-capacity    accept all proposals and retain every decoded position (required)\n"
            "  --allow-cpu              allow local CPU-only debugging; RPC remains rejected\n"
            "  --min-model-params N     debug override for the full-target gate (default: 150000000000)\n"
            "  --max-model-params N     debug override for the full-target gate (default: 200000000000)\n"
            "  --min-model-bytes N      debug override for loaded tensor bytes (default: 85899345920)\n"
            "  --max-model-bytes N      debug override for loaded tensor bytes (default: 139586437120)\n"
            "  --ready-file PATH        atomically created when the benchmark is ready to measure\n"
            "  --start-file PATH        measurement starts after this file exists\n"
            "  --barrier-timeout-ms N   start-file wait timeout (default: 120000)\n"
            "  -h, --help               show this help\n",
            argv0);
}

int32_t parse_i32(const char * name, const char * value) {
    int32_t result = 0;
    const char * end = value + std::strlen(value);
    const auto parsed = std::from_chars(value, end, result);
    if (parsed.ec != std::errc() || parsed.ptr != end) {
        throw std::runtime_error(std::string("invalid value for ") + name + ": " + value);
    }
    return result;
}

uint64_t parse_u64(const char * name, const char * value) {
    uint64_t result = 0;
    const char * end = value + std::strlen(value);
    const auto parsed = std::from_chars(value, end, result);
    if (parsed.ec != std::errc() || parsed.ptr != end) {
        throw std::runtime_error(std::string("invalid value for ") + name + ": " + value);
    }
    return result;
}

enum class parse_status { ok, help };

parse_status parse_options(int argc, char ** argv, options & opts) {
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-h" || arg == "--help") {
            print_usage(argv[0]);
            return parse_status::help;
        }
        if (arg == "--allow-cpu") {
            opts.allow_cpu = true;
            continue;
        }
        if (arg == "--accept-all-capacity") {
            opts.accept_all_capacity = true;
            continue;
        }
        if (i + 1 >= argc) {
            throw std::runtime_error("missing value for " + arg);
        }
        const char * value = argv[++i];
        if (arg == "--model") {
            opts.model = value;
        } else if (arg == "--seqs") {
            opts.seqs = parse_i32("--seqs", value);
        } else if (arg == "--rounds") {
            opts.rounds = parse_i32("--rounds", value);
        } else if (arg == "--warmups") {
            opts.warmups = parse_i32("--warmups", value);
        } else if (arg == "--prefix-tokens") {
            opts.prefix_tokens = parse_i32("--prefix-tokens", value);
        } else if (arg == "--proposals") {
            opts.proposals = parse_i32("--proposals", value);
        } else if (arg == "--ctx") {
            opts.n_ctx = parse_i32("--ctx", value);
        } else if (arg == "--gpu-layers") {
            opts.gpu_layers = parse_i32("--gpu-layers", value);
        } else if (arg == "--min-model-params") {
            opts.min_model_params = parse_u64("--min-model-params", value);
        } else if (arg == "--max-model-params") {
            opts.max_model_params = parse_u64("--max-model-params", value);
        } else if (arg == "--min-model-bytes") {
            opts.min_model_bytes = parse_u64("--min-model-bytes", value);
        } else if (arg == "--max-model-bytes") {
            opts.max_model_bytes = parse_u64("--max-model-bytes", value);
        } else if (arg == "--ready-file") {
            if (value[0] == '\0') {
                throw std::runtime_error("--ready-file must not be empty");
            }
            opts.ready_file = value;
        } else if (arg == "--start-file") {
            if (value[0] == '\0') {
                throw std::runtime_error("--start-file must not be empty");
            }
            opts.start_file = value;
        } else if (arg == "--barrier-timeout-ms") {
            opts.barrier_timeout_ms = parse_i32("--barrier-timeout-ms", value);
        } else {
            throw std::runtime_error("unknown argument: " + arg);
        }
    }

    if (opts.model.empty()) {
        throw std::runtime_error("--model is required");
    }
    if (!opts.accept_all_capacity) {
        throw std::runtime_error("--accept-all-capacity is required for this benchmark mode");
    }
    if (opts.seqs <= 0 || opts.rounds <= 0) {
        throw std::runtime_error("--seqs and --rounds must be positive");
    }
    if (opts.warmups < 3) {
        throw std::runtime_error("--warmups must be at least 3");
    }
    if (opts.prefix_tokens < 1) {
        throw std::runtime_error("--prefix-tokens must be at least 1");
    }
    if (opts.proposals != 1 && opts.proposals != DEFAULT_PROPOSALS) {
        throw std::runtime_error("--proposals must be 1 or 3 for this benchmark");
    }
    if (opts.gpu_layers < -1) {
        throw std::runtime_error("--gpu-layers must be -1 or greater");
    }
    if (opts.n_ctx <= 0) {
        throw std::runtime_error("--ctx must be positive");
    }
    const int64_t verification_cycles = (int64_t) opts.warmups + 1 + opts.rounds;
    const int64_t required_context_tokens = (int64_t) opts.prefix_tokens + verification_cycles * (1 + opts.proposals);
    if (required_context_tokens > opts.n_ctx || opts.seqs > opts.n_ctx / required_context_tokens) {
        throw std::runtime_error("--ctx must fit the retained prefix and all warmup, validation, and measured cycles for every sequence");
    }
    if (opts.min_model_params == 0 || opts.min_model_params > opts.max_model_params) {
        throw std::runtime_error("model parameter thresholds must be positive and ordered");
    }
    if (opts.min_model_bytes == 0 || opts.min_model_bytes > opts.max_model_bytes) {
        throw std::runtime_error("model byte thresholds must be positive and ordered");
    }
    if (opts.ready_file.empty() != opts.start_file.empty()) {
        throw std::runtime_error("--ready-file and --start-file must be supplied together");
    }
    if (opts.barrier_timeout_ms <= 0) {
        throw std::runtime_error("--barrier-timeout-ms must be positive");
    }
    return parse_status::ok;
}

size_t checked_mul_size(size_t a, size_t b, const char * what) {
    if (a != 0 && b > std::numeric_limits<size_t>::max() / a) {
        throw std::runtime_error(std::string(what) + " size overflows size_t");
    }
    return a * b;
}

uint64_t checked_mul_u64(uint64_t a, uint64_t b, const char * what) {
    if (a != 0 && b > std::numeric_limits<uint64_t>::max() / a) {
        throw std::runtime_error(std::string(what) + " count overflows uint64_t");
    }
    return a * b;
}

uint64_t primary_file_size(const std::string & path) {
    std::error_code ec;
    const uintmax_t size = std::filesystem::file_size(path, ec);
    if (ec) {
        throw std::runtime_error("cannot determine model file size for '" + path + "': " + ec.message());
    }
    if (size > std::numeric_limits<uint64_t>::max()) {
        throw std::runtime_error("model file size does not fit uint64_t");
    }
    return (uint64_t) size;
}

std::string model_meta(const llama_model * model, const char * key) {
    const int32_t size = llama_model_meta_val_str(model, key, nullptr, 0);
    if (size < 0) {
        return {};
    }
    std::vector<char> buffer((size_t) size + 1);
    if (llama_model_meta_val_str(model, key, buffer.data(), buffer.size()) < 0) {
        return {};
    }
    return buffer.data();
}

void validate_model(const llama_model * model, const options & opts) {
    const std::string architecture = model_meta(model, "general.architecture");
    if (architecture != "qwen4exp") {
        throw std::runtime_error("model architecture must be qwen4exp, got '" + architecture + "'");
    }
    if (llama_model_n_layer(model) != EXPECTED_N_LAYER) {
        throw std::runtime_error("Qwen4Exp target must have 48 trunk layers, got " + std::to_string(llama_model_n_layer(model)));
    }
    if (llama_model_n_embd(model) != EXPECTED_N_EMBD || llama_model_n_embd_out(model) != EXPECTED_N_EMBD_OUT) {
        throw std::runtime_error("Qwen4Exp target hidden widths must be 2560/10240, got " +
                std::to_string(llama_model_n_embd(model)) + "/" + std::to_string(llama_model_n_embd_out(model)));
    }
    const uint64_t params = llama_model_n_params(model);
    if (params < opts.min_model_params || params > opts.max_model_params) {
        throw std::runtime_error("loaded parameter count " + std::to_string(params) + " is outside [" +
                std::to_string(opts.min_model_params) + ", " + std::to_string(opts.max_model_params) +
                "]; expected the full target, not the MTP-only file");
    }
    const uint64_t bytes = llama_model_size(model);
    if (bytes < opts.min_model_bytes || bytes > opts.max_model_bytes) {
        throw std::runtime_error("loaded tensor size " + std::to_string(bytes) + " is outside [" +
                std::to_string(opts.min_model_bytes) + ", " + std::to_string(opts.max_model_bytes) +
                "]; expected the full quantized target");
    }
    const llama_vocab * vocab = llama_model_get_vocab(model);
    if (vocab == nullptr || llama_vocab_n_tokens(vocab) <= 1) {
        throw std::runtime_error("model vocabulary is missing or invalid");
    }
}

const char * device_type_name(enum ggml_backend_dev_type type) {
    switch (type) {
        case GGML_BACKEND_DEVICE_TYPE_CPU:   return "cpu";
        case GGML_BACKEND_DEVICE_TYPE_GPU:   return "gpu";
        case GGML_BACKEND_DEVICE_TYPE_IGPU:  return "igpu";
        case GGML_BACKEND_DEVICE_TYPE_ACCEL: return "accelerator";
        case GGML_BACKEND_DEVICE_TYPE_META:  return "meta";
    }
    return "unknown";
}

std::string device_registry_name(ggml_backend_dev_t device) {
    ggml_backend_reg_t registry = ggml_backend_dev_backend_reg(device);
    const char * name = registry == nullptr ? nullptr : ggml_backend_reg_name(registry);
    return name == nullptr ? "unknown" : name;
}

bool model_uses_device(const llama_model * model, ggml_backend_dev_t device) {
    for (int32_t i = 0; i < llama_model_n_devices(model); ++i) {
        if (llama_model_get_device(model, i) == device) {
            return true;
        }
    }
    return false;
}

void validate_placement(const llama_model * model, const options & opts) {
    bool has_local_gpu = false;
    bool has_rpc = false;
    for (int32_t i = 0; i < llama_model_n_devices(model); ++i) {
        ggml_backend_dev_t device = llama_model_get_device(model, i);
        if (device == nullptr) {
            throw std::runtime_error("model has a null device assignment");
        }
        const std::string registry = device_registry_name(device);
        if (registry == "RPC") {
            has_rpc = true;
        }
        const enum ggml_backend_dev_type type = ggml_backend_dev_type(device);
        if (registry != "RPC" && (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU)) {
            has_local_gpu = true;
        }
    }
    if (has_rpc) {
        throw std::runtime_error("RPC model assignments are not allowed; use a direct local GPU/Metal device");
    }
    if (opts.gpu_layers == 0 && !opts.allow_cpu) {
        throw std::runtime_error("--gpu-layers 0 requires --allow-cpu for local CPU debugging");
    }
    if (!has_local_gpu && !opts.allow_cpu) {
        throw std::runtime_error("no direct local GPU/Metal model assignment; use --allow-cpu only for local CPU debugging");
    }
}

uint64_t next_random(uint64_t & state) {
    state = state * 6364136223846793005ULL + 1442695040888963407ULL;
    return state;
}

llama_token fixture_token(uint64_t & state, int32_t n_vocab) {
    return 1 + (llama_token) (next_random(state) % (uint64_t) (n_vocab - 1));
}

token_fixture make_fixture(const llama_model * model, const options & opts) {
    token_fixture result;
    result.prefix.resize(checked_mul_size((size_t) opts.seqs, (size_t) opts.prefix_tokens, "prefix fixture"));
    result.current.resize((size_t) opts.seqs);
    result.proposals.resize(checked_mul_size((size_t) opts.seqs, (size_t) opts.proposals, "proposal fixture"));
    const int32_t n_vocab = llama_vocab_n_tokens(llama_model_get_vocab(model));
    uint64_t state = SEED;
    for (llama_token & token : result.prefix) {
        token = fixture_token(state, n_vocab);
    }
    for (llama_token & token : result.proposals) {
        token = fixture_token(state, n_vocab);
    }
    return result;
}

void validate_batch_allocation(const llama_batch & batch, int32_t rows) {
    if (batch.token == nullptr || batch.pos == nullptr || batch.n_seq_id == nullptr || batch.seq_id == nullptr || batch.logits == nullptr) {
        throw std::runtime_error("failed to allocate verification batch arrays");
    }
    for (int32_t row = 0; row < rows; ++row) {
        if (batch.seq_id[row] == nullptr) {
            throw std::runtime_error("failed to allocate verification batch sequence row " + std::to_string(row));
        }
    }
}

void prefill_prefix(
        llama_context * ctx,
        llama_batch & batch,
        llama_sampler * sampler,
        token_fixture & fixture,
        const options & opts) {
    const int32_t n_vocab = llama_vocab_n_tokens(llama_model_get_vocab(llama_get_model(ctx)));
    for (int32_t pos = 0; pos < opts.prefix_tokens; ++pos) {
        batch.n_tokens = opts.seqs;
        for (int32_t seq = 0; seq < opts.seqs; ++seq) {
            batch.token[seq]     = fixture.prefix[(size_t) seq * opts.prefix_tokens + pos];
            batch.pos[seq]       = pos;
            batch.n_seq_id[seq]  = 1;
            batch.seq_id[seq][0] = seq;
            batch.logits[seq]    = pos == opts.prefix_tokens - 1;
        }
        const int32_t rc = llama_decode(ctx, batch);
        if (rc != 0) {
            throw std::runtime_error("prefix llama_decode failed at position " + std::to_string(pos) + " with code " + std::to_string(rc));
        }
    }
    for (int32_t seq = 0; seq < opts.seqs; ++seq) {
        const llama_token token = llama_sampler_sample(sampler, ctx, seq);
        const float * logits = llama_get_logits_ith(ctx, seq);
        if (token < 0 || token >= n_vocab || logits == nullptr || !std::isfinite(logits[token])) {
            throw std::runtime_error("prefix sampling produced an invalid token or non-finite selected logit");
        }
        llama_sampler_accept(sampler, token);
        fixture.current[seq] = token;
    }
}

void fill_verification_batch(
        llama_batch & batch,
        const token_fixture & fixture,
        const options & opts,
        llama_pos base_pos) {
    const int32_t block_tokens = 1 + opts.proposals;
    batch.n_tokens = opts.seqs * block_tokens;
    for (int32_t seq = 0; seq < opts.seqs; ++seq) {
        for (int32_t step = 0; step < block_tokens; ++step) {
            const int32_t row = seq * block_tokens + step;
            batch.token[row] = step == 0 ? fixture.current[seq] :
                    fixture.proposals[(size_t) seq * opts.proposals + step - 1];
            batch.pos[row]       = base_pos + step;
            batch.n_seq_id[row]  = 1;
            batch.seq_id[row][0] = seq;
            batch.logits[row]    = 1;
        }
    }
}

std::vector<float> collect_selected_logits(
        llama_context * ctx,
        const token_fixture & fixture,
        const options & opts) {
    std::vector<float> selected(checked_mul_size((size_t) opts.seqs, (size_t) opts.proposals, "selected logit"));
    const int32_t block_tokens = 1 + opts.proposals;
    for (int32_t seq = 0; seq < opts.seqs; ++seq) {
        for (int32_t proposal = 0; proposal < opts.proposals; ++proposal) {
            const int32_t output = seq * block_tokens + proposal;
            const llama_token token = fixture.proposals[(size_t) seq * opts.proposals + proposal];
            const float * logits = llama_get_logits_ith(ctx, output);
            if (logits == nullptr || !std::isfinite(logits[token])) {
                throw std::runtime_error("verification selected logit is null or non-finite at sequence " +
                        std::to_string(seq) + ", proposal " + std::to_string(proposal));
            }
            selected[(size_t) seq * opts.proposals + proposal] = logits[token];
        }
    }
    return selected;
}

std::vector<llama_token> sample_next_current(
        llama_context * ctx,
        llama_sampler * sampler,
        const options & opts,
        int32_t output_stride,
        int32_t output_offset) {
    const int32_t n_vocab = llama_vocab_n_tokens(llama_model_get_vocab(llama_get_model(ctx)));
    std::vector<llama_token> next((size_t) opts.seqs);
    for (int32_t seq = 0; seq < opts.seqs; ++seq) {
        const int32_t output = seq * output_stride + output_offset;
        const llama_token token = llama_sampler_sample(sampler, ctx, output);
        const float * logits = llama_get_logits_ith(ctx, output);
        if (token < 0 || token >= n_vocab || logits == nullptr || !std::isfinite(logits[token])) {
            throw std::runtime_error("current-token sampling produced an invalid token or non-finite selected logit");
        }
        llama_sampler_accept(sampler, token);
        next[seq] = token;
    }
    return next;
}

void verify_position_max(llama_context * ctx, const options & opts, llama_pos expected, const char * label) {
    llama_memory_t memory = llama_get_memory(ctx);
    if (memory == nullptr) {
        throw std::runtime_error("context has no memory object");
    }
    for (llama_seq_id seq = 0; seq < opts.seqs; ++seq) {
        const llama_pos actual = llama_memory_seq_pos_max(memory, seq);
        if (actual != expected) {
            throw std::runtime_error(std::string(label) + " position max for sequence " + std::to_string(seq) +
                    " is " + std::to_string(actual) + ", expected " + std::to_string(expected));
        }
    }
}

std::vector<float> run_accept_all_cycle(
        llama_context * ctx,
        llama_batch & batch,
        llama_sampler * sampler,
        token_fixture & fixture,
        const options & opts,
        llama_pos & base_pos) {
    const int32_t block_tokens = 1 + opts.proposals;
    fill_verification_batch(batch, fixture, opts, base_pos);
    const int32_t rc = llama_decode(ctx, batch);
    if (rc != 0) {
        throw std::runtime_error("verification llama_decode failed with code " + std::to_string(rc));
    }
    const std::vector<float> selected = collect_selected_logits(ctx, fixture, opts);
    std::vector<llama_token> next = sample_next_current(ctx, sampler, opts, block_tokens, opts.proposals);
    verify_position_max(ctx, opts, base_pos + opts.proposals, "accepted verification block");
    fixture.current = std::move(next);
    base_pos += block_tokens;
    return selected;
}

std::string sha256_hex(sha256_t state) {
    unsigned char digest[SHA256_DIGEST_SIZE];
    sha256_final(&state, digest);
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (unsigned char byte : digest) {
        out << std::setw(2) << (unsigned int) byte;
    }
    return out.str();
}

void sha256_update_bytes(sha256_t & state, const void * data, size_t size) {
    if (size != 0) {
        sha256_update(&state, static_cast<const unsigned char *>(data), size);
    }
}

template<typename T>
void sha256_update_vector(sha256_t & state, const std::vector<T> & values) {
    sha256_update_bytes(state, values.data(), checked_mul_size(values.size(), sizeof(T), "SHA-256 input"));
}

template<typename T>
std::string vector_sha256(const std::vector<T> & values) {
    sha256_t state;
    sha256_init(&state);
    sha256_update_vector(state, values);
    return sha256_hex(state);
}

std::string fixture_sha256(const token_fixture & fixture) {
    sha256_t state;
    sha256_init(&state);
    sha256_update_vector(state, fixture.prefix);
    sha256_update_vector(state, fixture.current);
    sha256_update_vector(state, fixture.proposals);
    return sha256_hex(state);
}

double elapsed_ms(clock_type::time_point begin, clock_type::time_point end) {
    return std::chrono::duration<double, std::milli>(end - begin).count();
}

int64_t process_id() {
#if defined(_WIN32)
    return (int64_t) _getpid();
#else
    return (int64_t) getpid();
#endif
}

bool path_entry_exists(const std::filesystem::path & path, const char * label) {
    std::error_code ec;
    const std::filesystem::file_status status = std::filesystem::symlink_status(path, ec);
    if (ec == std::errc::no_such_file_or_directory) {
        return false;
    }
    if (ec) {
        throw std::runtime_error(std::string("cannot inspect ") + label + " '" + path.string() + "': " + ec.message());
    }
    return status.type() != std::filesystem::file_type::not_found;
}

void create_ready_file(const std::filesystem::path & ready_path) {
    if (path_entry_exists(ready_path, "ready-file")) {
        throw std::runtime_error("ready-file already exists: " + ready_path.string());
    }

    std::filesystem::path temporary_path = ready_path;
    temporary_path += ".tmp." + std::to_string(process_id()) + "." +
            std::to_string(clock_type::now().time_since_epoch().count());
    if (path_entry_exists(temporary_path, "temporary ready-file")) {
        throw std::runtime_error("temporary ready-file already exists: " + temporary_path.string());
    }

    try {
        {
            std::ofstream ready(temporary_path, std::ios::out | std::ios::trunc);
            if (!ready) {
                throw std::runtime_error("cannot create temporary ready-file: " + temporary_path.string());
            }
            ready << process_id() << '\n';
            ready.close();
            if (!ready) {
                throw std::runtime_error("cannot write temporary ready-file: " + temporary_path.string());
            }
        }

        std::error_code ec;
        std::filesystem::create_hard_link(temporary_path, ready_path, ec);
        if (ec) {
            throw std::runtime_error("cannot atomically create ready-file '" + ready_path.string() + "': " + ec.message());
        }
        if (!std::filesystem::remove(temporary_path, ec) || ec) {
            throw std::runtime_error("cannot remove temporary ready-file '" + temporary_path.string() + "': " + ec.message());
        }
    } catch (...) {
        std::error_code ec;
        std::filesystem::remove(temporary_path, ec);
        throw;
    }
}

void wait_for_measurement_barrier(const options & opts) {
    if (opts.ready_file.empty()) {
        return;
    }

    create_ready_file(std::filesystem::path(opts.ready_file));
    const std::filesystem::path start_path(opts.start_file);
    const auto deadline = clock_type::now() + std::chrono::milliseconds(opts.barrier_timeout_ms);
    while (!path_entry_exists(start_path, "start-file")) {
        const auto now = clock_type::now();
        if (now >= deadline) {
            throw std::runtime_error("timed out waiting for start-file: " + start_path.string());
        }
        std::this_thread::sleep_for(std::min(std::chrono::milliseconds(10),
                std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now)));
    }
}

double percentile(std::vector<double> values, double q) {
    if (values.empty()) {
        throw std::runtime_error("cannot compute percentile of an empty sample");
    }
    std::sort(values.begin(), values.end());
    const size_t rank = std::max<size_t>(1, (size_t) std::ceil(q * values.size()));
    return values[std::min(rank - 1, values.size() - 1)];
}

std::string json_escape(const std::string & value) {
    std::string result;
    result.reserve(value.size() + 8);
    for (unsigned char c : value) {
        switch (c) {
            case '\"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\b': result += "\\b";  break;
            case '\f': result += "\\f";  break;
            case '\n': result += "\\n";  break;
            case '\r': result += "\\r";  break;
            case '\t': result += "\\t";  break;
            default:
                if (c < 0x20) {
                    char escaped[7];
                    std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                    result += escaped;
                } else {
                    result += (char) c;
                }
        }
    }
    return result;
}

void print_json(
        const options & opts,
        const llama_model * model,
        const llama_context * ctx,
        uint64_t file_size,
        const token_fixture & fixture,
        double load_ms,
        double prefill_ms,
        double warmup_ms,
        double validation_ms,
        const std::vector<double> & batch_ms,
        llama_pos final_committed_position) {
    char description[256] = {};
    if (llama_model_desc(model, description, sizeof(description)) < 0) {
        std::strcpy(description, "unknown");
    }
    double total_ms = 0.0;
    for (double value : batch_ms) {
        total_ms += value;
    }
    const double seconds = total_ms / 1000.0;
    if (seconds <= 0.0) {
        throw std::runtime_error("measured batch duration is not positive");
    }
    const uint64_t blocks = checked_mul_u64((uint64_t) opts.rounds, (uint64_t) opts.seqs, "measured block");
    const uint64_t verified = checked_mul_u64(blocks, (uint64_t) (1 + opts.proposals), "verified token");
    const uint64_t proposals = checked_mul_u64(blocks, (uint64_t) opts.proposals, "proposal token");

    std::cout << std::fixed << std::setprecision(3);
    std::cout << "{\n";
    std::cout << "  \"benchmark\": \"target-verify-bench\",\n";
    std::cout << "  \"label\": \"prefetched-proposal accept-all verifier upper bound\",\n";
    std::cout << "  \"correctness\": false,\n";
    std::cout << "  \"end_to_end\": false,\n";
    std::cout << "  \"seed\": " << SEED << ",\n";
    std::cout << "  \"config\": {\"seqs\": " << opts.seqs
              << ", \"rounds\": " << opts.rounds
              << ", \"warmups\": " << opts.warmups
              << ", \"prefix_tokens\": " << opts.prefix_tokens
              << ", \"proposals\": " << opts.proposals
              << ", \"ctx_requested\": " << opts.n_ctx
              << ", \"gpu_layers\": " << opts.gpu_layers
              << ", \"accept_all_capacity\": true"
              << ", \"allow_cpu\": " << (opts.allow_cpu ? "true" : "false") << "},\n";
    std::cout << "  \"barrier\": {\"enabled\": " << (opts.ready_file.empty() ? "false" : "true")
              << ", \"ready_file\": \"" << json_escape(opts.ready_file)
              << "\", \"start_file\": \"" << json_escape(opts.start_file)
              << "\", \"timeout_ms\": " << opts.barrier_timeout_ms << "},\n";
    std::cout << "  \"context\": {\"total\": " << llama_n_ctx(ctx)
              << ", \"per_sequence\": " << llama_n_ctx_seq(ctx)
              << ", \"sequence_count\": " << llama_n_seq_max(ctx)
              << ", \"initial_prefix_tokens\": " << opts.prefix_tokens
              << ", \"verification_tokens_per_cycle\": " << 1 + opts.proposals
              << ", \"proposal_suffix_tokens\": " << opts.proposals
              << ", \"n_rs_seq\": " << llama_n_rs_seq(ctx)
              << ", \"final_committed_position\": " << final_committed_position << "},\n";
    std::cout << "  \"model\": {\"path\": \"" << json_escape(opts.model)
              << "\", \"description\": \"" << json_escape(description)
              << "\", \"architecture\": \"" << json_escape(model_meta(model, "general.architecture"))
              << "\", \"primary_file_size_bytes\": " << file_size
              << ", \"tensor_size_bytes\": " << llama_model_size(model)
              << ", \"parameters\": " << llama_model_n_params(model)
              << ", \"trunk_layers\": " << llama_model_n_layer(model)
              << ", \"hidden_dim\": " << llama_model_n_embd(model)
              << ", \"hidden_dim_out\": " << llama_model_n_embd_out(model)
              << ", \"size_gate\": {\"min_parameters\": " << opts.min_model_params
              << ", \"max_parameters\": " << opts.max_model_params
              << ", \"min_tensor_bytes\": " << opts.min_model_bytes
              << ", \"max_tensor_bytes\": " << opts.max_model_bytes << "}},\n";
    std::cout << "  \"placement\": {\"required\": \"direct local GPU/Metal\", \"rpc_allowed\": false, \"ple_ngram_embd\": \"CPU\", \"cpu_debug_opt_in\": "
              << (opts.allow_cpu ? "true" : "false") << ", \"passed\": true},\n";
    std::cout << "  \"model_assignments\": [";
    for (int32_t i = 0; i < llama_model_n_devices(model); ++i) {
        ggml_backend_dev_t device = llama_model_get_device(model, i);
        if (i != 0) {
            std::cout << ", ";
        }
        std::cout << "{\"registry\": \"" << json_escape(device_registry_name(device))
                  << "\", \"name\": \"" << json_escape(ggml_backend_dev_name(device))
                  << "\", \"type\": \"" << device_type_name(ggml_backend_dev_type(device)) << "\"}";
    }
    std::cout << "],\n";
    std::cout << "  \"devices\": [";
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t device = ggml_backend_dev_get(i);
        if (i != 0) {
            std::cout << ", ";
        }
        std::cout << "{\"registry\": \"" << json_escape(device_registry_name(device))
                  << "\", \"name\": \"" << json_escape(ggml_backend_dev_name(device))
                  << "\", \"description\": \"" << json_escape(ggml_backend_dev_description(device))
                  << "\", \"type\": \"" << device_type_name(ggml_backend_dev_type(device))
                  << "\", \"model_assigned\": " << (model_uses_device(model, device) ? "true" : "false") << "}";
    }
    std::cout << "],\n";
    std::cout << "  \"fixture\": {\"digest_algorithm\": \"SHA-256 over exact native token bytes\", \"sha256\": \""
              << fixture_sha256(fixture) << "\", \"proposal_sha256\": \"" << vector_sha256(fixture.proposals) << "\"},\n";
    std::cout << "  \"batch_latency_ms\": {\"p50\": " << percentile(batch_ms, 0.50)
              << ", \"p95\": " << percentile(batch_ms, 0.95)
              << ", \"mean\": " << total_ms / batch_ms.size()
              << ", \"total\": " << total_ms << "},\n";
    std::cout << "  \"untimed_ms\": {\"model_load\": " << load_ms
              << ", \"retained_prefix_prefill\": " << prefill_ms
              << ", \"warmups\": " << warmup_ms
              << ", \"accept_all_validation\": " << validation_ms << "},\n";
    std::cout << std::setprecision(2);
    std::cout << "  \"throughput\": {\"blocks_per_second\": " << blocks / seconds
              << ", \"verified_tokens_per_second\": " << verified / seconds << "},\n";
    std::cout << "  \"work\": {\"measured_batches\": " << opts.rounds
              << ", \"measured_blocks\": " << blocks
              << ", \"verified_tokens\": " << verified
              << ", \"proposal_tokens\": " << proposals
              << ", \"accepted_proposal_tokens\": " << proposals
              << ", \"committed_tokens\": " << verified << "},\n";
    std::cout << "  \"rollback\": {\"status\": \"not_exercised\", \"determinism_check\": \"not_exercised\"}\n";
    std::cout << "}\n";
}

} // namespace

int main(int argc, char ** argv) {
    try {
        options opts;
        if (parse_options(argc, argv, opts) == parse_status::help) {
            return 0;
        }

        const int64_t batch_rows_i64 = (int64_t) opts.seqs * (1 + opts.proposals);
        if (batch_rows_i64 > std::numeric_limits<int32_t>::max()) {
            throw std::runtime_error("verification batch row count exceeds int32_t");
        }
        if ((size_t) opts.seqs > llama_max_parallel_sequences()) {
            throw std::runtime_error("--seqs exceeds llama_max_parallel_sequences()");
        }
        checked_mul_u64((uint64_t) opts.rounds, (uint64_t) opts.seqs, "measured block");
        const int32_t batch_rows = (int32_t) batch_rows_i64;
        const uint64_t file_size = primary_file_size(opts.model);

        common_init();
        llama_backend_init();
        struct backend_guard {
            ~backend_guard() { llama_backend_free(); }
        } backend;

        llama_model_params model_params = llama_model_default_params();
        model_params.n_gpu_layers = opts.gpu_layers;
        model_params.load_mtp = false;
        const llama_model_tensor_buft_override tensor_overrides[] = {
            {"ple_ngram_embd", ggml_backend_cpu_buffer_type()},
            {nullptr, nullptr},
        };
        model_params.tensor_buft_overrides = tensor_overrides;

        const auto load_begin = clock_type::now();
        std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
                llama_model_load_from_file(opts.model.c_str(), model_params), llama_model_free);
        const auto load_end = clock_type::now();
        if (!model) {
            throw std::runtime_error("failed to load model: " + opts.model);
        }
        validate_model(model.get(), opts);
        validate_placement(model.get(), opts);

        llama_context_params context_params = llama_context_default_params();
        context_params.n_ctx     = opts.n_ctx;
        context_params.n_batch   = batch_rows;
        context_params.n_ubatch  = batch_rows;
        context_params.n_seq_max = opts.seqs;
        context_params.n_rs_seq  = opts.proposals;
        context_params.no_perf   = true;

        std::unique_ptr<llama_context, decltype(&llama_free)> ctx(
                llama_init_from_model(model.get(), context_params), llama_free);
        if (!ctx) {
            throw std::runtime_error("failed to create target context");
        }
        if (llama_n_seq_max(ctx.get()) < (uint32_t) opts.seqs) {
            throw std::runtime_error("context did not allocate the requested sequence count");
        }
        if (llama_n_rs_seq(ctx.get()) != (uint32_t) opts.proposals) {
            throw std::runtime_error("context did not allocate one recurrent-state snapshot per proposal");
        }
        const int64_t verification_cycles = (int64_t) opts.warmups + 1 + opts.rounds;
        const int64_t required_context_tokens =
                (int64_t) opts.prefix_tokens + verification_cycles * (1 + opts.proposals);
        if ((int64_t) llama_n_ctx_seq(ctx.get()) < required_context_tokens) {
            throw std::runtime_error("actual per-sequence context cannot fit all advancing verification cycles");
        }

        llama_batch batch = llama_batch_init(batch_rows, 0, 1);
        validate_batch_allocation(batch, batch_rows);
        struct batch_guard {
            llama_batch & batch;
            ~batch_guard() { llama_batch_free(batch); }
        } batch_owner { batch };

        std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(
                llama_sampler_init_greedy(), llama_sampler_free);
        if (!sampler) {
            throw std::runtime_error("failed to create greedy sampler");
        }

        token_fixture fixture = make_fixture(model.get(), opts);
        const auto prefill_begin = clock_type::now();
        prefill_prefix(ctx.get(), batch, sampler.get(), fixture, opts);
        verify_position_max(ctx.get(), opts, opts.prefix_tokens - 1, "initial prefix");
        const auto prefill_end = clock_type::now();

        llama_pos base_pos = opts.prefix_tokens;
        const auto warmup_begin = clock_type::now();
        for (int32_t warmup = 0; warmup < opts.warmups; ++warmup) {
            run_accept_all_cycle(ctx.get(), batch, sampler.get(), fixture, opts, base_pos);
        }
        const auto warmup_end = clock_type::now();

        const auto validation_begin = clock_type::now();
        run_accept_all_cycle(ctx.get(), batch, sampler.get(), fixture, opts, base_pos);
        const auto validation_end = clock_type::now();

        std::vector<double> batch_ms;
        batch_ms.reserve(opts.rounds);
        wait_for_measurement_barrier(opts);
        for (int32_t round = 0; round < opts.rounds; ++round) {
            const auto begin = clock_type::now();
            run_accept_all_cycle(ctx.get(), batch, sampler.get(), fixture, opts, base_pos);
            const auto end = clock_type::now();
            batch_ms.push_back(elapsed_ms(begin, end));
        }

        const llama_pos final_committed_position = base_pos - 1;
        verify_position_max(ctx.get(), opts, final_committed_position, "final committed");
        print_json(opts, model.get(), ctx.get(), file_size, fixture,
                elapsed_ms(load_begin, load_end), elapsed_ms(prefill_begin, prefill_end),
                elapsed_ms(warmup_begin, warmup_end), elapsed_ms(validation_begin, validation_end), batch_ms,
                final_committed_position);
        return 0;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "error: %s\n", error.what());
        return 1;
    }
}
