#include "common.h"
#include "ggml-backend.h"
#include "llama.h"
#include "remote-mtp-protocol.h"
#include "../../src/llama-ext.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <future>
#include <iomanip>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace remote_mtp;

namespace {

static constexpr int N_STREAMS = 4;
static constexpr int N_WORKERS = 2;

struct options {
    std::string model;
    std::array<std::string, N_WORKERS> endpoints{{"127.0.0.1:50051", "127.0.0.1:50052"}};
    std::array<std::string, N_WORKERS> worker_ids{{"worker0", "worker1"}};
    std::array<std::string, N_WORKERS> worker_digests;
    std::string model_sha;
    std::string device;
    std::string require_arch = "qwen4exp";
    std::string require_ftype = "Q4";
    uint32_t require_hidden = HIDDEN_WIDTH;
    uint32_t require_vocab = 0;
    uint32_t seqs = N_STREAMS;
    uint32_t tokens = 32;
    uint32_t warmup = 2;
    uint32_t ctx = 8192;
    uint32_t timeout_ms = 10000;
    float logit_tolerance = 1e-4f;
    float hidden_tolerance = 1e-4f;
    bool self_test = false;
    bool no_model_smoke = false;
    bool unsafe_skip_calibration = false;
};

void usage(const char * argv0) {
    std::printf("usage: %s --model FILE --endpoint0 HOST:PORT --endpoint1 HOST:PORT --model-sha SHA --worker-digest DIGEST [options]\n", argv0);
    std::printf("  --endpoints E0,E1       set both persistent worker endpoints (use loopback SSH tunnels for remote workers)\n");
    std::printf("  --worker-id0 ID         expected worker 0 identity (default worker0)\n");
    std::printf("  --worker-id1 ID         expected worker 1 identity (default worker1)\n");
    std::printf("  --worker-digests D0,D1  expected per-worker build digests\n");
    std::printf("  --device NAME           direct CUDA or Metal target device\n");
    std::printf("  --seqs 4                fixed sequence count (only 4 is accepted)\n");
    std::printf("  --tokens N              output tokens per stream (default 32)\n");
    std::printf("  --warmup N              untimed cycles (default 2)\n");
    std::printf("  --ctx N                 target context bound (default 8192)\n");
    std::printf("  --require-arch NAME     model architecture gate (default qwen4exp)\n");
    std::printf("  --require-ftype PREFIX  quantization gate (default Q4)\n");
    std::printf("  --require-hidden N      target hidden-width gate (default 10240)\n");
    std::printf("  --require-vocab N       optional exact vocabulary gate\n");
    std::printf("  --timeout-ms N          hard socket timeout (default 10000)\n");
    std::printf("  --logit-tolerance F     semantic-probe selected-logit tolerance (default 1e-4)\n");
    std::printf("  --hidden-tolerance F    semantic-probe hidden tolerance (default 1e-4)\n");
    std::printf("  --unsafe-skip-calibration  diagnostic timing only; disables correctness qualification\n");
    std::printf("  --protocol-self-test    run codec tests without a model or network\n");
    std::printf("  --no-model-smoke        validate CLI without a model or network\n");
    std::printf("  -h, --help              show this help\n");
}

std::array<std::string, 2> split_pair(const std::string & value, const char * name) {
    const size_t comma = value.find(',');
    if (comma == std::string::npos || value.find(',', comma + 1) != std::string::npos || comma == 0 || comma + 1 == value.size()) {
        throw std::runtime_error(std::string(name) + " must contain exactly two comma-separated values");
    }
    return {{value.substr(0, comma), value.substr(comma + 1)}};
}

uint32_t parse_u32(const std::string & text, const char * name) {
    size_t used = 0;
    const unsigned long value = std::stoul(text, &used);
    if (used != text.size() || value > UINT32_MAX) throw std::runtime_error(std::string("invalid ") + name);
    return (uint32_t) value;
}

float parse_float(const std::string & text, const char * name) {
    size_t used = 0;
    const float value = std::stof(text, &used);
    if (used != text.size() || !std::isfinite(value)) throw std::runtime_error(std::string("invalid ") + name);
    return value;
}

options parse_options(int argc, char ** argv, bool & help) {
    options result;
    help = false;
    auto value = [&](int & i, const char * name) -> std::string {
        if (++i >= argc) throw std::runtime_error(std::string("missing value for ") + name);
        return argv[i];
    };
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-h" || arg == "--help") help = true;
        else if (arg == "--model" || arg == "-m") result.model = value(i, arg.c_str());
        else if (arg == "--endpoint0") result.endpoints[0] = value(i, arg.c_str());
        else if (arg == "--endpoint1") result.endpoints[1] = value(i, arg.c_str());
        else if (arg == "--endpoints") result.endpoints = split_pair(value(i, arg.c_str()), "endpoints");
        else if (arg == "--worker-id0") result.worker_ids[0] = value(i, arg.c_str());
        else if (arg == "--worker-id1") result.worker_ids[1] = value(i, arg.c_str());
        else if (arg == "--worker-digest") { const std::string v = value(i, arg.c_str()); result.worker_digests = {{v, v}}; }
        else if (arg == "--worker-digests") result.worker_digests = split_pair(value(i, arg.c_str()), "worker-digests");
        else if (arg == "--model-sha") result.model_sha = value(i, arg.c_str());
        else if (arg == "--device") result.device = value(i, arg.c_str());
        else if (arg == "--seqs") result.seqs = parse_u32(value(i, arg.c_str()), "seqs");
        else if (arg == "--tokens") result.tokens = parse_u32(value(i, arg.c_str()), "tokens");
        else if (arg == "--warmup") result.warmup = parse_u32(value(i, arg.c_str()), "warmup");
        else if (arg == "--ctx") result.ctx = parse_u32(value(i, arg.c_str()), "ctx");
        else if (arg == "--timeout-ms") {
            result.timeout_ms = parse_u32(value(i, arg.c_str()), "timeout-ms");
            if (result.timeout_ms > INT_MAX) throw std::runtime_error("timeout-ms exceeds INT_MAX");
        }
        else if (arg == "--require-arch") result.require_arch = value(i, arg.c_str());
        else if (arg == "--require-ftype") result.require_ftype = value(i, arg.c_str());
        else if (arg == "--require-hidden") result.require_hidden = parse_u32(value(i, arg.c_str()), "require-hidden");
        else if (arg == "--require-vocab") result.require_vocab = parse_u32(value(i, arg.c_str()), "require-vocab");
        else if (arg == "--logit-tolerance") result.logit_tolerance = parse_float(value(i, arg.c_str()), "logit-tolerance");
        else if (arg == "--hidden-tolerance") result.hidden_tolerance = parse_float(value(i, arg.c_str()), "hidden-tolerance");
        else if (arg == "--unsafe-skip-calibration") result.unsafe_skip_calibration = true;
        else if (arg == "--protocol-self-test") result.self_test = true;
        else if (arg == "--no-model-smoke") result.no_model_smoke = true;
        else throw std::runtime_error("unknown option: " + arg);
    }
    return result;
}

std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) { return (char) std::tolower(c); });
    return value;
}

struct selected_device {
    ggml_backend_dev_t dev = nullptr;
    std::string backend;
};

selected_device select_local_device(const std::string & requested) {
    ggml_backend_dev_t selected = nullptr;
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        const std::string name = ggml_backend_dev_name(dev);
        const std::string reg = ggml_backend_reg_name(ggml_backend_dev_backend_reg(dev));
        const std::string tag = lower(name + " " + reg);
        std::fprintf(stderr, "remote-mtp device candidate: name=%s registry=%s type=%d requested=%s\n",
                name.c_str(), reg.c_str(), (int) ggml_backend_dev_type(dev), requested.c_str());
        if (tag.find("rpc") != std::string::npos) continue;
        if (tag.find("cuda") == std::string::npos && tag.find("metal") == std::string::npos && tag.find("mtl") == std::string::npos) continue;
        if (!requested.empty() && requested != name) continue;
        const auto type = ggml_backend_dev_type(dev);
        const bool metal_accel = (tag.find("metal") != std::string::npos || tag.find("mtl") != std::string::npos) && type == GGML_BACKEND_DEVICE_TYPE_ACCEL;
        if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU && !metal_accel) continue;
        if (selected) throw std::runtime_error("device name is ambiguous: " + requested);
        selected = dev;
        if (requested.empty()) break;
    }
    if (!selected) throw std::runtime_error("no matching direct local CUDA/Metal target device; RPC and CPU are not allowed");
    return {selected, ggml_backend_reg_name(ggml_backend_dev_backend_reg(selected))};
}

std::string model_meta(const llama_model * model, const char * key) {
    std::array<char, 256> buf{};
    if (llama_model_meta_val_str(model, key, buf.data(), buf.size()) < 0) return {};
    return buf.data();
}

struct model_deleter { void operator()(llama_model * p) const { llama_model_free(p); } };
struct context_deleter { void operator()(llama_context * p) const { llama_free(p); } };
using model_ptr = std::unique_ptr<llama_model, model_deleter>;
using context_ptr = std::unique_ptr<llama_context, context_deleter>;

struct rpc_result {
    infer_response response;
    uint64_t rtt_us = 0;
    uint64_t tx_bytes = 0;
    uint64_t rx_bytes = 0;
};

class worker_client {
public:
    worker_client(const std::string & endpoint, const std::string & worker_id, const std::string & worker_digest,
                  const std::string & model_sha, uint64_t campaign_epoch, int timeout_ms, uint32_t vocab)
        : fd_(connect_tcp(endpoint, timeout_ms)), epoch_(campaign_epoch), vocab_(vocab) {
        hello_request request{campaign_epoch, REQUIRED_FEATURES, model_sha, PROTOCOL_DIGEST, worker_id};
        send_frame(fd_.get(), message_type::hello_request, encode(request));
        const frame response_frame = recv_frame(fd_.get());
        if (response_frame.type == message_type::error_response) throw std::runtime_error("worker handshake failed: " + decode_error(response_frame.payload));
        if (response_frame.type != message_type::hello_response) throw std::runtime_error("worker sent invalid handshake response");
        const hello_response response = decode_hello_response(response_frame.payload);
        if (response.hidden_width != HIDDEN_WIDTH || response.vocab != vocab || response.supported_features != REQUIRED_FEATURES ||
            response.model_sha != model_sha || response.protocol_digest != PROTOCOL_DIGEST || response.worker_id != worker_id ||
            response.worker_digest != worker_digest || response.incarnation == 0) {
            throw std::runtime_error("worker attestation mismatch for " + endpoint);
        }
        incarnation_ = response.incarnation;
    }

    rpc_result infer(std::vector<sequence_rows> sequences) {
        infer_request request{epoch_, next_msg_id_++, std::move(sequences)};
        const std::vector<uint8_t> request_payload = encode(request);
        const uint64_t start = now_us();
        send_frame(fd_.get(), message_type::infer_request, request_payload);
        const frame response_frame = recv_frame(fd_.get());
        const uint64_t rtt = now_us() - start;
        if (response_frame.type == message_type::error_response) throw std::runtime_error("worker infer failed: " + decode_error(response_frame.payload));
        if (response_frame.type != message_type::infer_response) throw std::runtime_error("worker sent invalid infer response");
        infer_response response = decode_infer_response(response_frame.payload);
        if (response.campaign_epoch != epoch_ || response.msg_id != request.msg_id || response.proposals.size() != request.sequences.size()) {
            throw std::runtime_error("worker infer identity mismatch");
        }
        for (size_t i = 0; i < response.proposals.size(); ++i) {
            const auto & p = response.proposals[i];
            if (p.seq_id != request.sequences[i].seq_id || p.seq_id >= MAX_SEQS || p.token < 0 || (uint32_t) p.token >= vocab_ ||
                !std::isfinite(p.probability) || p.probability < 0 || p.probability > 1) {
                throw std::runtime_error("worker returned invalid proposal identity or value");
            }
        }
        return {std::move(response), rtt, 12 + request_payload.size(), 12 + response_frame.payload.size()};
    }

    uint64_t incarnation() const { return incarnation_; }

private:
    socket_handle fd_;
    uint64_t epoch_ = 0;
    uint64_t next_msg_id_ = 1;
    uint64_t incarnation_ = 0;
    uint32_t vocab_ = 0;
};

struct stream_state {
    llama_seq_id seq_id = 0;
    int worker = 0;
    uint8_t worker_seq = 0;
    uint32_t pos = 0;
    llama_token current = LLAMA_TOKEN_NULL;
    std::vector<float> hidden;
    std::optional<row> catch_up;
    std::vector<llama_token> output;
    uint64_t token_hash = 1469598103934665603ULL;
    uint64_t content_hash = 1469598103934665603ULL;
    uint64_t proposal_hash = 1469598103934665603ULL;
};

struct checkpoint {
    std::vector<uint8_t> bytes;
};

struct metrics {
    std::array<uint64_t, N_WORKERS> rtt_us{};
    std::array<uint64_t, N_WORKERS> compute_us{};
    std::array<uint64_t, N_WORKERS> queue_us{};
    std::array<uint64_t, N_WORKERS> tx_bytes{};
    std::array<uint64_t, N_WORKERS> rx_bytes{};
    uint64_t verify_us = 0;
    uint64_t partial_rollback_us = 0;
    uint64_t proposals = 0;
    uint64_t accepted = 0;
    uint64_t cycles = 0;
};

struct calibration_metrics {
    uint64_t semantic_probes = 0;
    uint64_t digest_stable = 0;
    uint64_t size_stable = 0;
};

struct probe_observation {
    llama_token greedy_token = LLAMA_TOKEN_NULL;
    float selected_logit = 0;
    std::vector<float> hidden;
    llama_pos pos = -1;
};

bool within_tolerance(float expected, float actual, float tolerance) {
    return std::isfinite(expected) && std::isfinite(actual) &&
            std::fabs(actual - expected) <= tolerance*std::max(1.0f, std::fabs(expected));
}

std::string compare_probe_observations(const probe_observation & expected, const probe_observation & actual,
                                       float logit_tolerance, float hidden_tolerance) {
    if (expected.greedy_token != actual.greedy_token) {
        return "greedy token mismatch: expected=" + std::to_string(expected.greedy_token) + " actual=" + std::to_string(actual.greedy_token);
    }
    if (!within_tolerance(expected.selected_logit, actual.selected_logit, logit_tolerance)) {
        return "selected logit mismatch: expected=" + std::to_string(expected.selected_logit) + " actual=" + std::to_string(actual.selected_logit);
    }
    if (expected.hidden.size() != actual.hidden.size()) {
        return "hidden width mismatch: expected=" + std::to_string(expected.hidden.size()) + " actual=" + std::to_string(actual.hidden.size());
    }
    for (size_t i = 0; i < expected.hidden.size(); ++i) {
        if (!within_tolerance(expected.hidden[i], actual.hidden[i], hidden_tolerance)) {
            return "hidden mismatch: index=" + std::to_string(i) + " expected=" + std::to_string(expected.hidden[i]) + " actual=" + std::to_string(actual.hidden[i]);
        }
    }
    if (expected.pos != actual.pos) {
        return "position mismatch: expected=" + std::to_string(expected.pos) + " actual=" + std::to_string(actual.pos);
    }
    return {};
}

bool semantic_helper_self_test(std::string & error) {
    probe_observation expected{7, 2.0f, {1.0f, -2.0f}, 9};
    probe_observation actual{7, 2.00005f, {1.00005f, -2.00005f}, 9};
    if (!compare_probe_observations(expected, actual, 1e-4f, 1e-4f).empty()) {
        error = "semantic tolerance accepted values were rejected";
        return false;
    }
    actual.greedy_token = 8;
    if (compare_probe_observations(expected, actual, 1e-4f, 1e-4f).empty()) {
        error = "semantic token mismatch was accepted";
        return false;
    }
    actual = expected;
    actual.selected_logit = 2.01f;
    if (compare_probe_observations(expected, actual, 1e-4f, 1e-4f).empty()) {
        error = "semantic logit mismatch was accepted";
        return false;
    }
    actual = expected;
    actual.hidden[1] = -2.01f;
    if (compare_probe_observations(expected, actual, 1e-4f, 1e-4f).empty()) {
        error = "semantic hidden mismatch was accepted";
        return false;
    }
    actual = expected;
    actual.pos = 10;
    if (compare_probe_observations(expected, actual, 1e-4f, 1e-4f).empty()) {
        error = "semantic position mismatch was accepted";
        return false;
    }
    return true;
}

struct target_runtime {
    const options & opts;
    model_ptr model;
    context_ptr ctx;
    int32_t vocab = 0;
    int32_t hidden_width = 0;

    target_runtime(const options & opts, ggml_backend_dev_t dev) : opts(opts) {
        std::array<ggml_backend_dev_t, 2> devices{{dev, nullptr}};
        std::array<llama_model_tensor_buft_override, 3> overrides{{
            {"blk\\.[0-9]+\\.ple_.*", ggml_backend_cpu_buffer_type()},
            {"token_embd\\.weight", ggml_backend_dev_buffer_type(dev)},
            {nullptr, nullptr},
        }};
        llama_model_params mp = llama_model_default_params();
        mp.devices = devices.data();
        mp.tensor_buft_overrides = overrides.data();
        mp.n_gpu_layers = -1;
        mp.split_mode = LLAMA_SPLIT_MODE_NONE;
        mp.load_mtp = false;
        model.reset(llama_model_load_from_file(opts.model.c_str(), mp));
        if (!model) throw std::runtime_error("failed to load target model");

        const std::string arch = model_meta(model.get(), "general.architecture");
        const std::string ftype = llama_ftype_name(llama_model_ftype(model.get()));
        hidden_width = llama_model_n_embd_out(model.get());
        vocab = llama_vocab_n_tokens(llama_model_get_vocab(model.get()));
        if (!opts.require_arch.empty() && arch != opts.require_arch) throw std::runtime_error("target architecture gate failed: " + arch);
        if (!opts.require_ftype.empty() && ftype.rfind(opts.require_ftype, 0) != 0) throw std::runtime_error("target ftype gate failed: " + ftype);
        if (hidden_width != (int32_t) opts.require_hidden || hidden_width != (int32_t) HIDDEN_WIDTH) throw std::runtime_error("target hidden-width gate failed");
        if (opts.require_vocab && vocab != (int32_t) opts.require_vocab) throw std::runtime_error("target vocabulary gate failed");
        if (llama_model_n_layer_nextn(model.get()) != 0) throw std::runtime_error("target model gate failed: expected separate MTP artifact, not embedded nextn layers");

        llama_context_params cp = llama_context_default_params();
        cp.n_ctx = opts.ctx;
        cp.n_batch = std::max<uint32_t>(256, 2*N_STREAMS);
        cp.n_ubatch = std::max<uint32_t>(64, 2*N_STREAMS);
        cp.n_seq_max = N_STREAMS;
        cp.n_rs_seq = 1;
        cp.n_outputs_max = 2*N_STREAMS;
        cp.n_outputs_max_per_seq = 2;
        cp.no_perf = false;
        ctx.reset(llama_init_from_model(model.get(), cp));
        if (!ctx) throw std::runtime_error("failed to create target context");
        if (llama_n_rs_seq(ctx.get()) != 1) throw std::runtime_error("target context did not enable n_rs_seq=1");
        llama_set_embeddings_nextn(ctx.get(), true, false);
    }
};

llama_token greedy(const float * logits, int32_t vocab) {
    if (!logits) throw std::runtime_error("target logits are unavailable");
    llama_token best = 0;
    for (llama_token token = 1; token < vocab; ++token) if (logits[token] > logits[best]) best = token;
    return best;
}

void save_checkpoint(llama_context * ctx, llama_seq_id seq, checkpoint & out) {
    const size_t size = llama_state_seq_get_size(ctx, seq);
    if (size == 0) throw std::runtime_error("target sequence checkpoint is empty");
    out.bytes.resize(size);
    if (llama_state_seq_get_data(ctx, out.bytes.data(), out.bytes.size(), seq) != out.bytes.size()) throw std::runtime_error("target checkpoint save failed");
}

void restore_checkpoint(llama_context * ctx, llama_seq_id seq, const checkpoint & in) {
    if (llama_state_seq_set_data(ctx, in.bytes.data(), in.bytes.size(), seq) != in.bytes.size()) throw std::runtime_error("target checkpoint restore failed");
}

std::string hex64(uint64_t value) {
    std::ostringstream out;
    out << std::hex << std::setw(16) << std::setfill('0') << value;
    return out.str();
}

std::string json_escape(const std::string & value) {
    std::string out;
    for (unsigned char c : value) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[7]; std::snprintf(buf, sizeof(buf), "\\u%04x", c); out += buf;
                } else out += (char) c;
        }
    }
    return out;
}

class benchmark {
public:
    benchmark(const options & opts, ggml_backend_dev_t dev)
        : opts_(opts), target_(opts, dev), campaign_epoch_(now_us() ^ ((uint64_t) target_.vocab << 32)) {
        if (campaign_epoch_ == 0) campaign_epoch_ = 1;
        for (int i = 0; i < N_STREAMS; ++i) {
            streams_[i].seq_id = i;
            streams_[i].worker = i / 2;
            streams_[i].worker_seq = i % 2;
            streams_[i].hidden.resize(HIDDEN_WIDTH);
        }
        for (int i = 0; i < N_WORKERS; ++i) {
            clients_[i] = std::make_unique<worker_client>(opts.endpoints[i], opts.worker_ids[i], opts.worker_digests[i],
                    opts.model_sha, campaign_epoch_, opts.timeout_ms, target_.vocab);
        }
        if (clients_[0]->incarnation() == clients_[1]->incarnation()) throw std::runtime_error("workers reported equal incarnations");
        prefill();
    }

    void run() {
        const std::array<std::array<bool, N_STREAMS>, 6> patterns{{
            {{true, false, false, false}},
            {{false, true, false, false}},
            {{false, false, true, false}},
            {{false, false, false, true}},
            {{true, false, true, false}},
            {{false, true, false, true}},
        }};
        if (!opts_.unsafe_skip_calibration) {
            for (const auto & pattern : patterns) cycle(&pattern, false, nullptr);
        }
        for (uint32_t i = 0; i < opts_.warmup; ++i) cycle(nullptr, false, nullptr);

        const uint64_t start = now_us();
        while (true) {
            bool done = true;
            for (const auto & stream : streams_) done = done && stream.output.size() >= opts_.tokens;
            if (done) break;
            cycle(nullptr, true, &timed_);
        }
        elapsed_us_ = now_us() - start;
        emit_json();
    }

private:
    const options & opts_;
    target_runtime target_;
    uint64_t campaign_epoch_ = 0;
    std::array<std::unique_ptr<worker_client>, N_WORKERS> clients_;
    std::array<stream_state, N_STREAMS> streams_;
    std::array<checkpoint, N_STREAMS> checkpoints_;
    metrics timed_;
    calibration_metrics calibration_;
    uint64_t elapsed_us_ = 0;

    probe_observation probe_checkpoint(const checkpoint & state, llama_seq_id seq, llama_token token, llama_pos pos) {
        restore_checkpoint(target_.ctx.get(), seq, state);
        llama_batch batch = llama_batch_init(1, 0, 1);
        common_batch_add(batch, token, pos, {seq}, true);
        if (llama_decode(target_.ctx.get(), batch) != 0) {
            llama_batch_free(batch);
            throw std::runtime_error("semantic checkpoint probe decode failed");
        }
        llama_synchronize(target_.ctx.get());
        const float * logits = llama_get_logits_ith(target_.ctx.get(), 0);
        const float * hidden = llama_get_embeddings_nextn_ith(target_.ctx.get(), 0);
        if (!logits || !hidden) {
            llama_batch_free(batch);
            throw std::runtime_error("semantic checkpoint probe output is unavailable");
        }
        probe_observation result;
        result.greedy_token = greedy(logits, target_.vocab);
        result.selected_logit = logits[result.greedy_token];
        result.hidden.assign(hidden, hidden + HIDDEN_WIDTH);
        result.pos = llama_memory_seq_pos_max(llama_get_memory(target_.ctx.get()), seq);
        llama_batch_free(batch);
        return result;
    }

    void compare_checkpoints_semantically(const checkpoint & expected_state, const checkpoint & desired_state,
                                          llama_seq_id seq, llama_token probe_token, llama_pos probe_pos, const char * label) {
        const uint64_t expected_digest = fnv1a64(expected_state.bytes.data(), expected_state.bytes.size());
        const uint64_t actual_digest = fnv1a64(desired_state.bytes.data(), desired_state.bytes.size());
        const bool size_stable = expected_state.bytes.size() == desired_state.bytes.size();
        const bool digest_stable = size_stable && expected_digest == actual_digest;
        ++calibration_.semantic_probes;
        if (size_stable) ++calibration_.size_stable;
        if (digest_stable) ++calibration_.digest_stable;

        probe_observation expected;
        probe_observation actual;
        try {
            expected = probe_checkpoint(expected_state, seq, probe_token, probe_pos);
            actual = probe_checkpoint(desired_state, seq, probe_token, probe_pos);
        } catch (...) {
            restore_checkpoint(target_.ctx.get(), seq, desired_state);
            throw;
        }
        restore_checkpoint(target_.ctx.get(), seq, desired_state);

        const std::string difference = compare_probe_observations(expected, actual, opts_.logit_tolerance, opts_.hidden_tolerance);
        const std::string raw = " expected_size=" + std::to_string(expected_state.bytes.size()) +
                " actual_size=" + std::to_string(desired_state.bytes.size()) +
                " expected_digest=" + hex64(expected_digest) + " actual_digest=" + hex64(actual_digest);
        if (!difference.empty()) {
            throw std::runtime_error(std::string(label) + " semantic checkpoint mismatch: seq=" + std::to_string(seq) + " " + difference + raw);
        }
        if (!digest_stable) {
            std::fprintf(stderr, "%s semantic checkpoint parity passed with raw instability: seq=%d%s\n", label, (int) seq, raw.c_str());
        }
    }

    void prefill() {
        static const std::array<const char *, N_STREAMS> prompts{{
            "Remote MTP deterministic benchmark stream zero:",
            "Remote MTP deterministic benchmark stream one:",
            "Remote MTP deterministic benchmark stream two:",
            "Remote MTP deterministic benchmark stream three:",
        }};
        std::array<llama_tokens, N_STREAMS> tokens;
        size_t total = 0;
        for (int i = 0; i < N_STREAMS; ++i) {
            tokens[i] = common_tokenize(target_.ctx.get(), prompts[i], true, true);
            if (tokens[i].empty()) throw std::runtime_error("fixed prefix tokenized to empty input");
            if (tokens[i].size() + 2*opts_.tokens + 32 >= opts_.ctx) throw std::runtime_error("fixed prefix and output exceed ctx bound");
            total += tokens[i].size();
        }
        if (total > llama_n_batch(target_.ctx.get())) throw std::runtime_error("fixed prefixes exceed target batch capacity");
        llama_batch batch = llama_batch_init((int32_t) total, 0, 1);
        std::array<int32_t, N_STREAMS> last_index{};
        for (int seq = 0; seq < N_STREAMS; ++seq) {
            for (size_t pos = 0; pos < tokens[seq].size(); ++pos) {
                const bool last = pos + 1 == tokens[seq].size();
                common_batch_add(batch, tokens[seq][pos], (llama_pos) pos, {(llama_seq_id) seq}, last);
                if (last) last_index[seq] = batch.n_tokens - 1;
            }
        }
        if (llama_decode(target_.ctx.get(), batch) != 0) { llama_batch_free(batch); throw std::runtime_error("target prefill decode failed"); }
        for (int seq = 0; seq < N_STREAMS; ++seq) {
            streams_[seq].current = greedy(llama_get_logits_ith(target_.ctx.get(), last_index[seq]), target_.vocab);
            const float * hidden = llama_get_embeddings_nextn_ith(target_.ctx.get(), last_index[seq]);
            if (!hidden) { llama_batch_free(batch); throw std::runtime_error("target prefill hidden output is unavailable"); }
            std::memcpy(streams_[seq].hidden.data(), hidden, HIDDEN_WIDTH*sizeof(float));
            streams_[seq].pos = (uint32_t) tokens[seq].size();
        }
        llama_batch_free(batch);
    }

    std::array<std::future<rpc_result>, N_WORKERS> launch_workers(const std::array<bool, N_STREAMS> & active) {
        std::array<std::future<rpc_result>, N_WORKERS> futures;
        for (int worker = 0; worker < N_WORKERS; ++worker) {
            std::vector<sequence_rows> sequences;
            for (int seq = 2*worker; seq < 2*worker + 2; ++seq) {
                if (!active[seq]) continue;
                std::vector<row> rows;
                if (streams_[seq].catch_up) {
                    rows.push_back(std::move(*streams_[seq].catch_up));
                    streams_[seq].catch_up.reset();
                }
                row current;
                current.pos = streams_[seq].pos;
                current.token = streams_[seq].current;
                current.hidden = streams_[seq].hidden;
                rows.push_back(std::move(current));
                sequences.push_back({streams_[seq].worker_seq, std::move(rows)});
            }
            if (sequences.empty()) continue;
            futures[worker] = std::async(std::launch::async, [this, worker, sequences = std::move(sequences)]() mutable {
                return clients_[worker]->infer(std::move(sequences));
            });
        }
        return futures;
    }

    void cycle(const std::array<bool, N_STREAMS> * force_reject, bool count_output, metrics * out_metrics) {
        std::array<bool, N_STREAMS> active{};
        for (int seq = 0; seq < N_STREAMS; ++seq) active[seq] = !count_output || streams_[seq].output.size() < opts_.tokens;
        auto futures = launch_workers(active);

        std::array<llama_token, N_STREAMS> baseline_greedy{};
        std::array<checkpoint, N_STREAMS> baseline_state;
        if (force_reject) {
            for (int seq = 0; seq < N_STREAMS; ++seq) if (active[seq]) {
                save_checkpoint(target_.ctx.get(), seq, checkpoints_[seq]);
            }
            llama_batch baseline = llama_batch_init(N_STREAMS, 0, 1);
            std::array<int32_t, N_STREAMS> index{};
            for (int seq = 0; seq < N_STREAMS; ++seq) {
                common_batch_add(baseline, streams_[seq].current, streams_[seq].pos, {(llama_seq_id) seq}, true);
                index[seq] = baseline.n_tokens - 1;
            }
            if (llama_decode(target_.ctx.get(), baseline) != 0) { llama_batch_free(baseline); throw std::runtime_error("calibration baseline decode failed"); }
            llama_synchronize(target_.ctx.get());
            for (int seq = 0; seq < N_STREAMS; ++seq) {
                baseline_greedy[seq] = greedy(llama_get_logits_ith(target_.ctx.get(), index[seq]), target_.vocab);
                save_checkpoint(target_.ctx.get(), seq, baseline_state[seq]);
            }
            llama_batch_free(baseline);
            for (int seq = 0; seq < N_STREAMS; ++seq) restore_checkpoint(target_.ctx.get(), seq, checkpoints_[seq]);
        }

        std::array<llama_token, N_STREAMS> proposals{};
        for (int worker = 0; worker < N_WORKERS; ++worker) {
            if (!futures[worker].valid()) continue;
            rpc_result result = futures[worker].get();
            if (out_metrics) {
                out_metrics->rtt_us[worker] += result.rtt_us;
                out_metrics->compute_us[worker] += result.response.compute_us;
                out_metrics->queue_us[worker] += result.response.queue_us;
                out_metrics->tx_bytes[worker] += result.tx_bytes;
                out_metrics->rx_bytes[worker] += result.rx_bytes;
            }
            for (const auto & p : result.response.proposals) {
                const int seq = 2*worker + p.seq_id;
                if (seq < 0 || seq >= N_STREAMS || !active[seq]) throw std::runtime_error("worker proposal mapped to inactive sequence");
                proposals[seq] = p.token;
            }
        }
        if (force_reject) {
            for (int seq = 0; seq < N_STREAMS; ++seq) {
                proposals[seq] = (*force_reject)[seq] ? (baseline_greedy[seq] + 1) % target_.vocab : baseline_greedy[seq];
            }
        }

        llama_batch verify = llama_batch_init(2*N_STREAMS, 0, 1);
        std::array<int32_t, N_STREAMS> current_index{};
        std::array<int32_t, N_STREAMS> proposal_index{};
        for (int seq = 0; seq < N_STREAMS; ++seq) {
            if (!active[seq]) continue;
            common_batch_add(verify, streams_[seq].current, streams_[seq].pos, {(llama_seq_id) seq}, true);
            current_index[seq] = verify.n_tokens - 1;
            common_batch_add(verify, proposals[seq], streams_[seq].pos + 1, {(llama_seq_id) seq}, true);
            proposal_index[seq] = verify.n_tokens - 1;
        }
        const uint64_t verify_start = now_us();
        if (llama_decode(target_.ctx.get(), verify) != 0) { llama_batch_free(verify); throw std::runtime_error("target verification decode failed"); }
        llama_synchronize(target_.ctx.get());
        const uint64_t verify_time = now_us() - verify_start;

        std::array<bool, N_STREAMS> accepted{};
        std::array<llama_token, N_STREAMS> current_greedy{};
        std::array<llama_token, N_STREAMS> proposal_greedy{};
        std::array<std::vector<float>, N_STREAMS> current_hidden;
        std::array<std::vector<float>, N_STREAMS> proposal_hidden;
        for (int seq = 0; seq < N_STREAMS; ++seq) {
            if (!active[seq]) continue;
            current_greedy[seq] = greedy(llama_get_logits_ith(target_.ctx.get(), current_index[seq]), target_.vocab);
            proposal_greedy[seq] = greedy(llama_get_logits_ith(target_.ctx.get(), proposal_index[seq]), target_.vocab);
            accepted[seq] = proposals[seq] == current_greedy[seq];
            const float * h0 = llama_get_embeddings_nextn_ith(target_.ctx.get(), current_index[seq]);
            const float * h1 = llama_get_embeddings_nextn_ith(target_.ctx.get(), proposal_index[seq]);
            current_hidden[seq].assign(h0, h0 + HIDDEN_WIDTH);
            proposal_hidden[seq].assign(h1, h1 + HIDDEN_WIDTH);
            if (force_reject && accepted[seq] == (*force_reject)[seq]) throw std::runtime_error("forced calibration acceptance pattern failed");
        }

        std::array<checkpoint, N_STREAMS> accepted_state;
        if (force_reject) {
            for (int seq = 0; seq < N_STREAMS; ++seq) if (accepted[seq]) {
                save_checkpoint(target_.ctx.get(), seq, accepted_state[seq]);
            }
        }

        const uint64_t rollback_start = now_us();
        for (int seq = 0; seq < N_STREAMS; ++seq) if (active[seq] && !accepted[seq]) {
            if (!llama_memory_seq_rm(llama_get_memory(target_.ctx.get()), seq, (llama_pos) streams_[seq].pos + 1, -1)) {
                llama_batch_free(verify);
                throw std::runtime_error("target partial rejection rollback failed");
            }
            if (llama_memory_seq_pos_max(llama_get_memory(target_.ctx.get()), seq) != (llama_pos) streams_[seq].pos) {
                llama_batch_free(verify);
                throw std::runtime_error("rejected target lane has wrong position after partial rollback");
            }
        }
        for (int seq = 0; seq < N_STREAMS; ++seq) if (active[seq] && accepted[seq] &&
                llama_memory_seq_pos_max(llama_get_memory(target_.ctx.get()), seq) != (llama_pos) streams_[seq].pos + 1) {
            llama_batch_free(verify);
            throw std::runtime_error("accepted target lane changed during partial rollback");
        }
        const uint64_t rollback_time = now_us() - rollback_start;

        if (force_reject) {
            std::array<checkpoint, N_STREAMS> desired_state;
            for (int seq = 0; seq < N_STREAMS; ++seq) {
                save_checkpoint(target_.ctx.get(), seq, desired_state[seq]);
            }
            for (int seq = 0; seq < N_STREAMS; ++seq) {
                if (accepted[seq]) {
                    compare_checkpoints_semantically(accepted_state[seq], desired_state[seq], seq,
                            proposal_greedy[seq], (llama_pos) streams_[seq].pos + 2, "accepted-lane partial rollback");
                } else {
                    compare_checkpoints_semantically(baseline_state[seq], desired_state[seq], seq,
                            baseline_greedy[seq], (llama_pos) streams_[seq].pos + 1, "rejected-lane partial rollback");
                }
            }
        }

        for (int seq = 0; seq < N_STREAMS; ++seq) {
            if (!active[seq]) continue;
            streams_[seq].proposal_hash = fnv1a64(&proposals[seq], sizeof(proposals[seq]), streams_[seq].proposal_hash);
            if (count_output) append_output(seq, streams_[seq].current);
            if (accepted[seq]) {
                if (count_output && streams_[seq].output.size() < opts_.tokens) append_output(seq, proposals[seq]);
                row catch_up;
                catch_up.pos = streams_[seq].pos + 1;
                catch_up.token = proposals[seq];
                catch_up.hidden = std::move(current_hidden[seq]);
                streams_[seq].catch_up = std::move(catch_up);
                streams_[seq].current = proposal_greedy[seq];
                streams_[seq].hidden = std::move(proposal_hidden[seq]);
                streams_[seq].pos += 2;
            } else {
                streams_[seq].current = current_greedy[seq];
                streams_[seq].hidden = std::move(current_hidden[seq]);
                streams_[seq].pos += 1;
            }
            if (out_metrics) {
                ++out_metrics->proposals;
                if (accepted[seq]) ++out_metrics->accepted;
            }
        }
        if (out_metrics) {
            out_metrics->verify_us += verify_time;
            out_metrics->partial_rollback_us += rollback_time;
            ++out_metrics->cycles;
        }
        llama_batch_free(verify);
    }

    void append_output(int seq, llama_token token) {
        streams_[seq].output.push_back(token);
        streams_[seq].token_hash = fnv1a64(&token, sizeof(token), streams_[seq].token_hash);
        const std::string piece = common_token_to_piece(target_.ctx.get(), token);
        streams_[seq].content_hash = fnv1a64(piece.data(), piece.size(), streams_[seq].content_hash);
    }

    void emit_json() const {
        uint64_t total_tokens = 0;
        uint64_t aggregate_token_hash = 1469598103934665603ULL;
        uint64_t aggregate_content_hash = 1469598103934665603ULL;
        uint64_t aggregate_proposal_hash = 1469598103934665603ULL;
        for (const auto & stream : streams_) {
            total_tokens += stream.output.size();
            aggregate_token_hash = fnv1a64(&stream.token_hash, sizeof(stream.token_hash), aggregate_token_hash);
            aggregate_content_hash = fnv1a64(&stream.content_hash, sizeof(stream.content_hash), aggregate_content_hash);
            aggregate_proposal_hash = fnv1a64(&stream.proposal_hash, sizeof(stream.proposal_hash), aggregate_proposal_hash);
        }
        const double seconds = elapsed_us_ / 1e6;
        std::printf("{\n");
        std::printf("  \"benchmark\": \"remote-mtp-e2e-n1-f16-partial\",\n");
        std::printf("  \"mode\": {\"hiddenWire\": \"ieee-binary16-le\", \"rollback\": \"partial\", \"nRsSeq\": 1, \"correctnessCalibration\": \"%s\"},\n",
                opts_.unsafe_skip_calibration ? "skipped-unsafe" : "passed");
        std::printf("  \"campaign_epoch\": %llu,\n", (unsigned long long) campaign_epoch_);
        std::printf("  \"protocol_digest\": \"%s\",\n", PROTOCOL_DIGEST);
        std::printf("  \"model_sha\": \"%s\",\n", json_escape(opts_.model_sha).c_str());
        std::printf("  \"seqs\": 4, \"n\": 1, \"tokens_per_stream\": %u, \"warmup_cycles\": %u,\n", opts_.tokens, opts_.warmup);
        std::printf("  \"elapsed_us\": %llu, \"good_tokens\": %llu, \"good_tokens_per_second\": %.6f,\n",
                (unsigned long long) elapsed_us_, (unsigned long long) total_tokens, total_tokens / seconds);
        std::printf("  \"acceptance\": {\"accepted\": %llu, \"proposals\": %llu, \"rate\": %.6f},\n",
                (unsigned long long) timed_.accepted, (unsigned long long) timed_.proposals,
                timed_.proposals ? (double) timed_.accepted/timed_.proposals : 0.0);
        std::printf("  \"calibration\": {\"semanticProbes\": %llu, \"digestStable\": %s, \"digestStableCount\": %llu, \"sizeStableCount\": %llu},\n",
                (unsigned long long) calibration_.semantic_probes,
                calibration_.semantic_probes == calibration_.digest_stable ? "true" : "false",
                (unsigned long long) calibration_.digest_stable, (unsigned long long) calibration_.size_stable);
        std::printf("  \"timing_us\": {\"checkpointTimedCostUs\": 0, \"targetVerifyUs\": %llu, \"partialRollbackUs\": %llu, \"cycles\": %llu},\n",
                (unsigned long long) timed_.verify_us, (unsigned long long) timed_.partial_rollback_us,
                (unsigned long long) timed_.cycles);
        const uint64_t tx_bytes = timed_.tx_bytes[0] + timed_.tx_bytes[1];
        const uint64_t rx_bytes = timed_.rx_bytes[0] + timed_.rx_bytes[1];
        std::printf("  \"transport_bytes\": {\"tx\": %llu, \"rx\": %llu, \"total\": %llu},\n",
                (unsigned long long) tx_bytes, (unsigned long long) rx_bytes, (unsigned long long) (tx_bytes + rx_bytes));
        std::printf("  \"workers\": [\n");
        for (int i = 0; i < N_WORKERS; ++i) {
            std::printf("    {\"id\": \"%s\", \"endpoint\": \"%s\", \"incarnation\": %llu, \"rtt_us\": %llu, \"compute_us\": %llu, \"queue_us\": %llu, \"tx_bytes\": %llu, \"rx_bytes\": %llu}%s\n",
                    json_escape(opts_.worker_ids[i]).c_str(), json_escape(opts_.endpoints[i]).c_str(),
                    (unsigned long long) clients_[i]->incarnation(), (unsigned long long) timed_.rtt_us[i],
                    (unsigned long long) timed_.compute_us[i], (unsigned long long) timed_.queue_us[i],
                    (unsigned long long) timed_.tx_bytes[i], (unsigned long long) timed_.rx_bytes[i], i + 1 == N_WORKERS ? "" : ",");
        }
        std::printf("  ],\n  \"streams\": [\n");
        for (int i = 0; i < N_STREAMS; ++i) {
            const auto & stream = streams_[i];
            std::string content;
            for (llama_token token : stream.output) content += common_token_to_piece(target_.ctx.get(), token);
            std::printf("    {\"stream\": %d, \"tokens\": %zu, \"tokens_per_second\": %.6f, \"token_hash\": \"%s\", \"content_hash\": \"%s\", \"proposal_hash\": \"%s\", \"content\": \"%s\"}%s\n",
                    i, stream.output.size(), stream.output.size()/seconds, hex64(stream.token_hash).c_str(), hex64(stream.content_hash).c_str(),
                    hex64(stream.proposal_hash).c_str(), json_escape(content).c_str(), i + 1 == N_STREAMS ? "" : ",");
        }
        std::printf("  ],\n");
        std::printf("  \"aggregate_hashes\": {\"token\": \"%s\", \"content\": \"%s\", \"proposal\": \"%s\"}\n",
                hex64(aggregate_token_hash).c_str(), hex64(aggregate_content_hash).c_str(), hex64(aggregate_proposal_hash).c_str());
        std::printf("}\n");
    }
};

} // namespace

int main(int argc, char ** argv) {
    try {
        bool help = false;
        const options opts = parse_options(argc, argv, help);
        if (help) { usage(argv[0]); return 0; }
        if (opts.self_test) {
            std::string error;
            if (!protocol_self_test(error)) throw std::runtime_error("protocol self-test failed: " + error);
            if (!semantic_helper_self_test(error)) throw std::runtime_error("semantic helper self-test failed: " + error);
            std::puts("{\"protocol_self_test\":\"ok\",\"semantic_helper_self_test\":\"ok\"}");
            return 0;
        }
        if (opts.endpoints[0] == opts.endpoints[1]) throw std::runtime_error("worker endpoints must be distinct");
        if (opts.worker_ids[0] == opts.worker_ids[1]) throw std::runtime_error("worker IDs must be distinct");
        if (opts.timeout_ms == 0 || opts.timeout_ms > INT_MAX) throw std::runtime_error("timeout-ms is invalid");
        if (opts.no_model_smoke) {
            for (const auto & endpoint : opts.endpoints) (void) split_endpoint(endpoint);
            if (opts.seqs != 4 || opts.tokens == 0 || opts.ctx == 0 || opts.logit_tolerance < 0 || opts.hidden_tolerance < 0) throw std::runtime_error("invalid smoke-test options");
            std::puts("{\"no_model_smoke\":\"ok\",\"seqs\":4,\"n\":1,\"hidden_width\":10240,\"hidden_wire\":\"f16le\",\"rollback\":\"partial-rs1\"}");
            return 0;
        }
        if (opts.model.empty() || opts.model_sha.empty() || opts.worker_digests[0].empty() || opts.worker_digests[1].empty()) {
            usage(argv[0]);
            throw std::runtime_error("--model, --model-sha, and --worker-digest(s) are required");
        }
        if (opts.seqs != 4) throw std::runtime_error("this kill benchmark requires exactly --seqs 4");
        if (opts.tokens == 0 || opts.ctx == 0 || opts.logit_tolerance < 0 || opts.hidden_tolerance < 0) throw std::runtime_error("tokens, ctx, timeout, and tolerance are invalid");
        for (const auto & endpoint : opts.endpoints) (void) split_endpoint(endpoint);

        llama_backend_init();
        const selected_device device = select_local_device(opts.device);
        std::fprintf(stderr, "llama-remote-mtp-e2e-bench: direct target device %s (%s), PLE tensors forced to CPU\n",
                ggml_backend_dev_name(device.dev), device.backend.c_str());
        {
            benchmark bench(opts, device.dev);
            bench.run();
        }
        llama_backend_free();
        return 0;
    } catch (const std::exception & e) {
        std::fprintf(stderr, "llama-remote-mtp-e2e-bench: %s\n", e.what());
        return 1;
    }
}
