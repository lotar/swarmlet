#include "ggml-backend.h"
#include "llama.h"
#include "../../src/llama-ext.h"

extern "C" {
#include "hash/sha256/sha256.h"
}

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <charconv>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <sstream>
#include <string>
#include <system_error>
#include <vector>

namespace {

constexpr int32_t  HIDDEN_DIM             = 10240;
constexpr int32_t  N_DRAFT                = 3;
constexpr int32_t  DEFAULT_PREFIX_TOKENS  = 4;
constexpr int32_t  DEFAULT_WARMUPS        = 3;
constexpr uint64_t DEFAULT_MAX_MODEL_BYTES = 16ULL * 1024 * 1024 * 1024;
constexpr uint64_t SEED                    = 0x4d5450574f524b45ULL;
constexpr float    DETERMINISM_ABS_TOL     = 1e-6f;
constexpr float    DETERMINISM_REL_TOL     = 1e-6f;

struct options {
    std::string model;
    int32_t seqs         = 2;
    int32_t rounds       = 20;
    int32_t warmups      = DEFAULT_WARMUPS;
    int32_t prefix_tokens = DEFAULT_PREFIX_TOKENS;
    int32_t n_draft      = N_DRAFT;
    int32_t n_ctx        = 128;
    int32_t gpu_layers   = 99;
    uint64_t max_model_bytes = DEFAULT_MAX_MODEL_BYTES;
    bool allow_cpu       = false;
};

struct authoritative_input {
    std::vector<llama_token> tokens;
    std::vector<float> hidden;
};

struct block_result {
    std::vector<llama_token> tokens;
    std::vector<float> selected_logits;
    std::vector<float> hidden_rows;
};

struct determinism_result {
    std::string first_hidden_sha256;
    std::string replay_hidden_sha256;
};

using clock_type = std::chrono::steady_clock;

void print_usage(const char * argv0) {
    std::printf(
            "Usage: %s --model MODEL [options]\n"
            "\n"
            "Benchmark an MTP-only Qwen4Exp GGUF with deterministic batched inputs.\n"
            "\n"
            "Options:\n"
            "  --model PATH          MTP-only Qwen4Exp GGUF (required)\n"
            "  --seqs N              parallel sequences (default: 2)\n"
            "  --rounds N            measured draft-and-rollback rounds (default: 20)\n"
            "  --warmups N           untimed warmup blocks, at least 3 (default: 3)\n"
            "  --prefix-tokens N     retained untimed prefix positions, at least 1 (default: 4)\n"
            "  --n-draft N           proposals per block; must be 3 (default: 3)\n"
            "  --ctx N               total context size (default: 128)\n"
            "  --gpu-layers N        layers to offload, -1 means all (default: 99)\n"
            "  --max-model-bytes N   reject larger files/models (default: 17179869184); sized for MTP-only BF16/Q4, not a full trunk\n"
            "  --allow-cpu           bypass the assigned-CUDA gate for local CPU debugging only\n"
            "  -h, --help            show this help\n",
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
        } else if (arg == "--n-draft") {
            opts.n_draft = parse_i32("--n-draft", value);
        } else if (arg == "--ctx") {
            opts.n_ctx = parse_i32("--ctx", value);
        } else if (arg == "--gpu-layers") {
            opts.gpu_layers = parse_i32("--gpu-layers", value);
        } else if (arg == "--max-model-bytes") {
            opts.max_model_bytes = parse_u64("--max-model-bytes", value);
        } else {
            throw std::runtime_error("unknown argument: " + arg);
        }
    }

    if (opts.model.empty()) {
        throw std::runtime_error("--model is required");
    }
    if (opts.seqs <= 0) {
        throw std::runtime_error("--seqs must be positive");
    }
    if (opts.rounds <= 0) {
        throw std::runtime_error("--rounds must be positive");
    }
    if (opts.warmups < 3) {
        throw std::runtime_error("--warmups must be at least 3");
    }
    if (opts.prefix_tokens <= 0) {
        throw std::runtime_error("--prefix-tokens must be positive so the base position is nonzero");
    }
    if (opts.n_draft != N_DRAFT) {
        throw std::runtime_error("--n-draft must be 3 for this benchmark");
    }
    if (opts.prefix_tokens > std::numeric_limits<int32_t>::max() - opts.n_draft) {
        throw std::runtime_error("--prefix-tokens plus --n-draft overflows the position range");
    }
    if (opts.n_ctx < opts.prefix_tokens + opts.n_draft) {
        throw std::runtime_error("--ctx must fit --prefix-tokens plus --n-draft");
    }
    if (opts.gpu_layers < -1) {
        throw std::runtime_error("--gpu-layers must be -1 or greater");
    }
    if (opts.max_model_bytes == 0) {
        throw std::runtime_error("--max-model-bytes must be positive");
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

uint64_t model_file_size(const std::string & path) {
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

void validate_model(const llama_model * model, uint64_t max_model_bytes) {
    const uint64_t size = llama_model_size(model);
    if (size > max_model_bytes) {
        throw std::runtime_error("loaded model tensor size " + std::to_string(size) +
                " bytes exceeds --max-model-bytes " + std::to_string(max_model_bytes) +
                "; use an MTP-only BF16/Q4 fixture, not a full trunk model");
    }

    const std::string architecture = model_meta(model, "general.architecture");
    if (architecture != "qwen4exp") {
        throw std::runtime_error("model architecture must be qwen4exp, got '" + architecture + "'");
    }
    if (llama_model_n_embd_out(model) != HIDDEN_DIM) {
        throw std::runtime_error("Qwen4Exp MTP hidden width must be 10240, got " +
                std::to_string(llama_model_n_embd_out(model)));
    }
    if (llama_model_n_layer_nextn(model) != 1) {
        throw std::runtime_error("Qwen4Exp MTP model must contain exactly one NextN layer, got " +
                std::to_string(llama_model_n_layer_nextn(model)));
    }

    const llama_vocab * vocab = llama_model_get_vocab(model);
    if (vocab == nullptr || llama_vocab_n_tokens(vocab) <= 1) {
        throw std::runtime_error("model vocabulary is missing or invalid");
    }
}

uint64_t next_random(uint64_t & state) {
    state = state * 6364136223846793005ULL + 1442695040888963407ULL;
    return state;
}

authoritative_input make_authoritative_input(const llama_model * model, int32_t n_seqs) {
    authoritative_input result;
    result.tokens.resize((size_t) n_seqs);
    result.hidden.resize(checked_mul_size((size_t) n_seqs, (size_t) HIDDEN_DIM, "authoritative hidden input"));

    const int32_t n_vocab = llama_vocab_n_tokens(llama_model_get_vocab(model));
    uint64_t state = SEED;
    for (int32_t seq = 0; seq < n_seqs; ++seq) {
        result.tokens[seq] = 1 + (llama_token) (next_random(state) % (uint64_t) (n_vocab - 1));
        for (int32_t j = 0; j < HIDDEN_DIM; ++j) {
            const uint32_t bits = (uint32_t) (next_random(state) >> 40);
            result.hidden[(size_t) seq * HIDDEN_DIM + j] = (float) bits / 16777216.0f - 0.5f;
        }
    }

    return result;
}

void resize_block_result(block_result & result, int32_t n_seqs, int32_t n_draft) {
    const size_t rows = checked_mul_size((size_t) n_seqs, (size_t) n_draft, "draft result row");
    result.tokens.resize(rows);
    result.selected_logits.resize(rows);
    result.hidden_rows.resize(checked_mul_size(rows, (size_t) HIDDEN_DIM, "draft result hidden"));
}

void validate_finite(const float * values, size_t count, const char * what) {
    if (values == nullptr) {
        throw std::runtime_error(std::string(what) + " is null");
    }
    for (size_t i = 0; i < count; ++i) {
        if (!std::isfinite(values[i])) {
            throw std::runtime_error(std::string(what) + " contains a non-finite value at element " + std::to_string(i));
        }
    }
}

void validate_batch_allocation(const llama_batch & batch, int32_t n_seqs) {
    if (batch.embd == nullptr || batch.pos == nullptr || batch.n_seq_id == nullptr || batch.seq_id == nullptr || batch.logits == nullptr) {
        throw std::runtime_error("failed to allocate MTP batch arrays");
    }
    for (int32_t row = 0; row < n_seqs; ++row) {
        if (batch.seq_id[row] == nullptr) {
            throw std::runtime_error("failed to allocate MTP batch sequence row " + std::to_string(row));
        }
    }
}

void fill_batch(
        llama_batch & batch,
        const std::vector<llama_token> & tokens,
        const std::vector<float> & hidden,
        int32_t n_seqs,
        llama_pos pos) {
    batch.n_tokens = n_seqs;
    for (int32_t seq = 0; seq < n_seqs; ++seq) {
        batch.token[seq]       = tokens[seq];
        batch.pos[seq]         = pos;
        batch.n_seq_id[seq]    = 1;
        batch.seq_id[seq][0]   = seq;
        batch.logits[seq]      = 1;
        std::memcpy(batch.embd + (size_t) seq * HIDDEN_DIM,
                hidden.data() + (size_t) seq * HIDDEN_DIM,
                (size_t) HIDDEN_DIM * sizeof(float));
    }
}

void decode_chain_step(
        llama_context * ctx,
        llama_batch & batch,
        const std::vector<llama_sampler *> & samplers,
        std::vector<llama_token> & current_tokens,
        std::vector<float> & current_hidden,
        int32_t n_seqs,
        llama_pos pos,
        int32_t output_step,
        int32_t n_draft,
        block_result * result) {
    fill_batch(batch, current_tokens, current_hidden, n_seqs, pos);
    const int32_t rc = llama_decode(ctx, batch);
    if (rc != 0) {
        throw std::runtime_error("llama_decode failed at position " + std::to_string(pos) +
                " with code " + std::to_string(rc));
    }

    const int32_t n_vocab = llama_vocab_n_tokens(llama_model_get_vocab(llama_get_model(ctx)));
    for (int32_t seq = 0; seq < n_seqs; ++seq) {
        const llama_token token = llama_sampler_sample(samplers[seq], ctx, seq);
        const float * logits = llama_get_logits_ith(ctx, seq);
        if (token < 0 || token >= n_vocab) {
            throw std::runtime_error("greedy sampler returned an invalid token ID");
        }
        if (logits == nullptr || !std::isfinite(logits[token])) {
            throw std::runtime_error("selected logit is null or non-finite");
        }

        const float * next_hidden = llama_get_embeddings_nextn_ith(ctx, seq);
        validate_finite(next_hidden, HIDDEN_DIM, "MTP output hidden row");
        if (result != nullptr) {
            const size_t row = (size_t) seq * n_draft + output_step;
            result->tokens[row] = token;
            result->selected_logits[row] = logits[token];
            std::memcpy(result->hidden_rows.data() + row * HIDDEN_DIM,
                    next_hidden, (size_t) HIDDEN_DIM * sizeof(float));
        }
        current_tokens[seq] = token;
        std::memcpy(current_hidden.data() + (size_t) seq * HIDDEN_DIM,
                next_hidden, (size_t) HIDDEN_DIM * sizeof(float));
    }
}

authoritative_input prefill_retained_prefix(
        llama_context * ctx,
        llama_batch & batch,
        const std::vector<llama_sampler *> & samplers,
        const authoritative_input & fixture,
        int32_t n_seqs,
        int32_t prefix_tokens) {
    authoritative_input current = fixture;
    validate_finite(current.hidden.data(), current.hidden.size(), "fixture hidden input");
    for (int32_t pos = 0; pos < prefix_tokens; ++pos) {
        decode_chain_step(ctx, batch, samplers, current.tokens, current.hidden, n_seqs, pos, 0, 1, nullptr);
    }
    return current;
}

void draft_block(
        llama_context * ctx,
        llama_batch & batch,
        const std::vector<llama_sampler *> & samplers,
        const authoritative_input & input,
        int32_t n_seqs,
        int32_t n_draft,
        llama_pos base_pos,
        block_result & result) {
    std::vector<llama_token> current_tokens = input.tokens;
    std::vector<float> current_hidden = input.hidden;
    validate_finite(current_hidden.data(), current_hidden.size(), "authoritative hidden input");

    for (int32_t step = 0; step < n_draft; ++step) {
        decode_chain_step(ctx, batch, samplers, current_tokens, current_hidden, n_seqs,
                base_pos + step, step, n_draft, &result);
    }
}

void verify_retained_prefix(llama_context * ctx, int32_t n_seqs, llama_pos base_pos) {
    llama_memory_t memory = llama_get_memory(ctx);
    if (memory == nullptr) {
        throw std::runtime_error("context has no memory object");
    }
    for (llama_seq_id seq = 0; seq < n_seqs; ++seq) {
        const llama_pos pos_max = llama_memory_seq_pos_max(memory, seq);
        if (pos_max != base_pos - 1) {
            throw std::runtime_error("retained prefix position max for sequence " + std::to_string(seq) +
                    " is " + std::to_string(pos_max) + ", expected " + std::to_string(base_pos - 1));
        }
    }
}

void rollback_suffix(llama_context * ctx, int32_t n_seqs, llama_pos base_pos) {
    llama_memory_t memory = llama_get_memory(ctx);
    if (memory == nullptr) {
        throw std::runtime_error("context has no memory object");
    }
    for (llama_seq_id seq = 0; seq < n_seqs; ++seq) {
        if (!llama_memory_seq_rm(memory, seq, base_pos, -1)) {
            throw std::runtime_error("failed to remove speculative suffix for sequence " + std::to_string(seq));
        }
    }
    verify_retained_prefix(ctx, n_seqs, base_pos);
}

bool within_tolerance(float a, float b) {
    const float difference = std::fabs(a - b);
    return difference <= DETERMINISM_ABS_TOL + DETERMINISM_REL_TOL * std::max(std::fabs(a), std::fabs(b));
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

std::string fixture_sha256(const authoritative_input & input) {
    sha256_t state;
    sha256_init(&state);
    sha256_update_vector(state, input.tokens);
    sha256_update_vector(state, input.hidden);
    return sha256_hex(state);
}

determinism_result validate_rollback_determinism(
        llama_context * ctx,
        llama_batch & batch,
        const std::vector<llama_sampler *> & samplers,
        const authoritative_input & input,
        int32_t n_seqs,
        int32_t n_draft,
        llama_pos base_pos,
        block_result & first,
        block_result & replay) {
    draft_block(ctx, batch, samplers, input, n_seqs, n_draft, base_pos, first);
    rollback_suffix(ctx, n_seqs, base_pos);
    draft_block(ctx, batch, samplers, input, n_seqs, n_draft, base_pos, replay);

    if (first.tokens != replay.tokens) {
        throw std::runtime_error("rollback determinism failed: replay token IDs differ");
    }
    for (size_t i = 0; i < first.selected_logits.size(); ++i) {
        if (!within_tolerance(first.selected_logits[i], replay.selected_logits[i])) {
            throw std::runtime_error("rollback determinism failed: selected logit differs at row " + std::to_string(i));
        }
    }
    for (size_t i = 0; i < first.hidden_rows.size(); ++i) {
        if (!within_tolerance(first.hidden_rows[i], replay.hidden_rows[i])) {
            throw std::runtime_error("rollback determinism failed: hidden output differs at element " + std::to_string(i));
        }
    }

    determinism_result result;
    result.first_hidden_sha256 = vector_sha256(first.hidden_rows);
    result.replay_hidden_sha256 = vector_sha256(replay.hidden_rows);
    rollback_suffix(ctx, n_seqs, base_pos);
    return result;
}

double elapsed_ms(clock_type::time_point begin, clock_type::time_point end) {
    return std::chrono::duration<double, std::milli>(end - begin).count();
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

void validate_physical_device_gate(const llama_model * model, bool allow_cpu) {
    bool has_assigned_device = false;
    bool has_assigned_cuda = false;
    bool has_assigned_non_cpu = false;

    for (int32_t i = 0; i < llama_model_n_devices(model); ++i) {
        ggml_backend_dev_t device = llama_model_get_device(model, i);
        if (device == nullptr) {
            throw std::runtime_error("model has a null effective device assignment");
        }
        has_assigned_device = true;
        const std::string registry = device_registry_name(device);
        if (registry == "RPC") {
            throw std::runtime_error("model-assigned RPC device '" + std::string(ggml_backend_dev_name(device)) +
                    "' is not valid for the physical CUDA gate");
        }
        if (registry == "CUDA") {
            has_assigned_cuda = true;
        }
        const enum ggml_backend_dev_type type = ggml_backend_dev_type(device);
        if (type != GGML_BACKEND_DEVICE_TYPE_CPU && type != GGML_BACKEND_DEVICE_TYPE_ACCEL) {
            has_assigned_non_cpu = true;
        }
    }

    if (!has_assigned_device) {
        throw std::runtime_error("model has no effective device assignments");
    }
    if (has_assigned_cuda) {
        return;
    }
    if (!allow_cpu) {
        throw std::runtime_error("model must have at least one model-assigned CUDA device; use --allow-cpu only for local CPU debugging");
    }
    if (has_assigned_non_cpu) {
        throw std::runtime_error("--allow-cpu cannot bypass the CUDA gate for a non-CPU device assignment");
    }
}

void print_token_array(const std::vector<llama_token> & tokens) {
    std::cout << "[";
    for (size_t i = 0; i < tokens.size(); ++i) {
        if (i != 0) {
            std::cout << ", ";
        }
        std::cout << tokens[i];
    }
    std::cout << "]";
}

void print_json(
        const options & opts,
        const llama_model * model,
        const llama_context * ctx,
        uint64_t primary_file_size,
        const authoritative_input & fixture,
        const authoritative_input & start,
        const determinism_result & determinism,
        const std::string & proposal_sha256,
        double load_ms,
        double prefix_prefill_ms,
        double warmup_ms,
        double validation_ms,
        const std::vector<double> & round_ms) {
    char description[256] = {};
    if (llama_model_desc(model, description, sizeof(description)) < 0) {
        std::strcpy(description, "unknown");
    }

    double timed_ms = 0.0;
    for (double value : round_ms) {
        timed_ms += value;
    }
    const double timed_seconds = timed_ms / 1000.0;
    if (timed_seconds <= 0.0) {
        throw std::runtime_error("measured duration is not positive");
    }
    const uint64_t blocks = checked_mul_u64((uint64_t) opts.rounds, (uint64_t) opts.seqs, "measured block");
    const uint64_t proposals = checked_mul_u64(blocks, (uint64_t) opts.n_draft, "measured proposal");
    const uint64_t warmup_blocks = checked_mul_u64((uint64_t) opts.warmups, (uint64_t) opts.seqs, "warmup block");
    const uint32_t per_seq_context = llama_n_ctx_seq(ctx);

    std::cout << std::fixed << std::setprecision(3);
    std::cout << "{\n";
    std::cout << "  \"benchmark\": \"mtp-worker-bench\",\n";
    std::cout << "  \"seed\": " << SEED << ",\n";
    std::cout << "  \"config\": {\"seqs\": " << opts.seqs
              << ", \"rounds\": " << opts.rounds
              << ", \"warmups\": " << opts.warmups
              << ", \"n_draft\": " << opts.n_draft
              << ", \"gpu_layers\": " << opts.gpu_layers
              << ", \"allow_cpu\": " << (opts.allow_cpu ? "true" : "false") << "},\n";
    std::cout << "  \"context\": {\"total\": " << llama_n_ctx(ctx)
              << ", \"per_sequence\": " << per_seq_context
              << ", \"base_position\": " << opts.prefix_tokens
              << ", \"retained_prefix_tokens\": " << opts.prefix_tokens
              << ", \"draft_capacity_tokens_per_sequence\": " << per_seq_context - (uint32_t) opts.prefix_tokens << "},\n";
    std::cout << "  \"model\": {\"path\": \"" << json_escape(opts.model)
              << "\", \"description\": \"" << json_escape(description)
              << "\", \"architecture\": \"" << json_escape(model_meta(model, "general.architecture"))
              << "\", \"primary_file_size_bytes\": " << primary_file_size
              << ", \"tensor_size_bytes\": " << llama_model_size(model)
              << ", \"max_model_bytes\": " << opts.max_model_bytes
              << ", \"parameters\": " << llama_model_n_params(model)
              << ", \"hidden_dim\": " << llama_model_n_embd_out(model)
              << ", \"nextn_layers\": " << llama_model_n_layer_nextn(model) << "},\n";
    std::cout << "  \"physical_gate\": {\"required_assignment\": \"CUDA\", \"rpc_assignments_allowed\": false, \"cpu_debug_opt_out\": "
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
    std::cout << "  \"fixture\": {\"digest_algorithm\": \"SHA-256 over exact native token and float bytes\", \"sha256\": \""
              << fixture_sha256(fixture) << "\", \"start_tokens_after_prefix\": ";
    print_token_array(start.tokens);
    std::cout << ", \"start_tokens_sha256\": \"" << vector_sha256(start.tokens)
              << "\", \"measured_proposals_sha256\": \"" << proposal_sha256 << "\"},\n";
    std::cout << "  \"timing_ms\": {\n";
    std::cout << "    \"model_load\": " << load_ms << ",\n";
    std::cout << "    \"retained_prefix_prefill\": " << prefix_prefill_ms << ",\n";
    std::cout << "    \"warmup_total\": " << warmup_ms << ",\n";
    std::cout << "    \"rollback_determinism_validation\": " << validation_ms << ",\n";
    std::cout << "    \"measured_capacity_total\": " << timed_ms << ",\n";
    std::cout << "    \"measured_round\": {\"p50\": " << percentile(round_ms, 0.50)
              << ", \"p95\": " << percentile(round_ms, 0.95) << "}\n";
    std::cout << "  },\n";
    std::cout << std::setprecision(2);
    std::cout << "  \"throughput\": {\"label\": \"lockstep raw compute upper bound\", \"proposal_tokens_per_second\": "
              << proposals / timed_seconds << ", \"blocks_per_second\": " << blocks / timed_seconds << "},\n";
    std::cout << "  \"work\": {\"measured_blocks\": " << blocks
              << ", \"measured_proposal_tokens\": " << proposals
              << ", \"warmup_blocks\": " << warmup_blocks
              << ", \"validation_blocks\": " << (uint64_t) opts.seqs * 2 << "},\n";
    std::cout << std::setprecision(8);
    std::cout << "  \"rollback_determinism\": {\"checks_per_output\": [\"token_id_exact\", \"selected_logit_tolerance\", \"returned_hidden_row_tolerance\"], "
              << "\"abs_tolerance\": " << DETERMINISM_ABS_TOL
              << ", \"rel_tolerance\": " << DETERMINISM_REL_TOL
              << ", \"first_hidden_rows_sha256\": \"" << determinism.first_hidden_sha256
              << "\", \"replay_hidden_rows_sha256\": \"" << determinism.replay_hidden_sha256
              << "\", \"identical_within_tolerance\": true}\n";
    std::cout << "}\n";
}

} // namespace

int main(int argc, char ** argv) {
    try {
        options opts;
        if (parse_options(argc, argv, opts) == parse_status::help) {
            return 0;
        }

        const uint64_t primary_file_size = model_file_size(opts.model);
        if (primary_file_size > opts.max_model_bytes) {
            throw std::runtime_error("model file size " + std::to_string(primary_file_size) +
                    " bytes exceeds --max-model-bytes " + std::to_string(opts.max_model_bytes) +
                    "; use an MTP-only BF16/Q4 fixture, not a full trunk model");
        }

        llama_backend_init();
        struct backend_guard {
            ~backend_guard() { llama_backend_free(); }
        } backend;

        if ((size_t) opts.seqs > llama_max_parallel_sequences()) {
            throw std::runtime_error("--seqs exceeds llama_max_parallel_sequences()");
        }
        checked_mul_size((size_t) opts.seqs, (size_t) HIDDEN_DIM, "MTP batch embedding");
        checked_mul_size((size_t) opts.seqs, sizeof(llama_token), "MTP token batch");
        checked_mul_u64((uint64_t) opts.rounds, (uint64_t) opts.seqs, "measured block");

        llama_model_params model_params = llama_model_default_params();
        model_params.n_gpu_layers = opts.gpu_layers;
        model_params.load_mtp = true;

        const auto load_begin = clock_type::now();
        std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
                llama_model_load_from_file(opts.model.c_str(), model_params), llama_model_free);
        const auto load_end = clock_type::now();
        if (!model) {
            throw std::runtime_error("failed to load model: " + opts.model);
        }
        validate_model(model.get(), opts.max_model_bytes);
        validate_physical_device_gate(model.get(), opts.allow_cpu);

        llama_context_params context_params = llama_context_default_params();
        context_params.ctx_type  = LLAMA_CONTEXT_TYPE_MTP;
        context_params.n_ctx     = opts.n_ctx;
        context_params.n_batch   = opts.seqs;
        context_params.n_ubatch  = opts.seqs;
        context_params.n_seq_max = opts.seqs;
        context_params.no_perf   = true;

        std::unique_ptr<llama_context, decltype(&llama_free)> ctx(
                llama_init_from_model(model.get(), context_params), llama_free);
        if (!ctx) {
            throw std::runtime_error("failed to create MTP context");
        }
        if (llama_n_ctx_seq(ctx.get()) < (uint32_t) (opts.prefix_tokens + opts.n_draft)) {
            throw std::runtime_error("actual per-sequence context cannot fit retained prefix plus draft block");
        }
        if (llama_n_seq_max(ctx.get()) < (uint32_t) opts.seqs) {
            throw std::runtime_error("context did not allocate the requested sequence count");
        }
        llama_set_embeddings_nextn(ctx.get(), true, true);

        llama_batch batch = llama_batch_init(opts.seqs, HIDDEN_DIM, 1);
        try {
            validate_batch_allocation(batch, opts.seqs);
        } catch (...) {
            llama_batch_free(batch);
            throw;
        }
        batch.token = (llama_token *) std::malloc(checked_mul_size((size_t) opts.seqs, sizeof(llama_token), "MTP token batch"));
        if (batch.token == nullptr) {
            llama_batch_free(batch);
            throw std::runtime_error("failed to allocate MTP token batch");
        }
        struct batch_guard {
            llama_batch & batch;
            ~batch_guard() {
                std::free(batch.token);
                batch.token = nullptr;
                llama_batch_free(batch);
            }
        } batch_owner { batch };

        std::vector<std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)>> sampler_owners;
        std::vector<llama_sampler *> samplers;
        sampler_owners.reserve(opts.seqs);
        samplers.reserve(opts.seqs);
        for (int32_t seq = 0; seq < opts.seqs; ++seq) {
            sampler_owners.emplace_back(llama_sampler_init_greedy(), llama_sampler_free);
            if (!sampler_owners.back()) {
                throw std::runtime_error("failed to create greedy sampler");
            }
            samplers.push_back(sampler_owners.back().get());
        }

        block_result first;
        block_result replay;
        block_result measured;
        resize_block_result(first, opts.seqs, opts.n_draft);
        resize_block_result(replay, opts.seqs, opts.n_draft);
        resize_block_result(measured, opts.seqs, opts.n_draft);

        const authoritative_input fixture = make_authoritative_input(model.get(), opts.seqs);
        const auto prefix_begin = clock_type::now();
        const authoritative_input start = prefill_retained_prefix(
                ctx.get(), batch, samplers, fixture, opts.seqs, opts.prefix_tokens);
        verify_retained_prefix(ctx.get(), opts.seqs, opts.prefix_tokens);
        const auto prefix_end = clock_type::now();

        const auto warmup_begin = clock_type::now();
        for (int32_t warmup = 0; warmup < opts.warmups; ++warmup) {
            draft_block(ctx.get(), batch, samplers, start, opts.seqs, opts.n_draft, opts.prefix_tokens, measured);
            rollback_suffix(ctx.get(), opts.seqs, opts.prefix_tokens);
        }
        const auto warmup_end = clock_type::now();

        const auto validation_begin = clock_type::now();
        const determinism_result determinism = validate_rollback_determinism(
                ctx.get(), batch, samplers, start, opts.seqs, opts.n_draft, opts.prefix_tokens, first, replay);
        const auto validation_end = clock_type::now();

        sha256_t proposal_digest;
        sha256_init(&proposal_digest);
        std::vector<double> round_ms;
        round_ms.reserve(opts.rounds);
        for (int32_t round = 0; round < opts.rounds; ++round) {
            const auto begin = clock_type::now();
            draft_block(ctx.get(), batch, samplers, start, opts.seqs, opts.n_draft, opts.prefix_tokens, measured);
            rollback_suffix(ctx.get(), opts.seqs, opts.prefix_tokens);
            const auto end = clock_type::now();
            round_ms.push_back(elapsed_ms(begin, end));
            sha256_update_vector(proposal_digest, measured.tokens);
        }

        print_json(opts, model.get(), ctx.get(), primary_file_size, fixture, start, determinism,
                sha256_hex(proposal_digest), elapsed_ms(load_begin, load_end), elapsed_ms(prefix_begin, prefix_end),
                elapsed_ms(warmup_begin, warmup_end), elapsed_ms(validation_begin, validation_end), round_ms);
        return 0;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "error: %s\n", error.what());
        return 1;
    }
}
