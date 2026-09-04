#include "common.h"
#include "ggml-backend.h"
#include "llama.h"
#include "remote-mtp-protocol.h"
#include "../../src/llama-ext.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#  include <process.h>
#else
#  include <unistd.h>
#endif

using namespace remote_mtp;

namespace {

struct options {
    std::string model;
    std::string host = "127.0.0.1";
    std::string port = "50051";
    std::string worker_id;
    std::string model_sha;
    std::string worker_digest;
    std::string device;
    uint32_t max_pos = 8192;
    uint64_t max_model_bytes = 8ULL*1024*1024*1024;
    int timeout_ms = 10000;
    bool self_test = false;
    bool no_model_smoke = false;
};

void usage(const char * argv0) {
    std::printf("usage: %s --model FILE --worker-id ID --model-sha SHA --worker-digest DIGEST [options]\n", argv0);
    std::printf("  --host HOST             listen host (default 127.0.0.1; use an SSH tunnel for remote access)\n");
    std::printf("  --port PORT             listen port (default 50051)\n");
    std::printf("  --device NAME           direct CUDA or Metal device (default first local device)\n");
    std::printf("  --max-pos N             exclusive position bound (default 8192)\n");
    std::printf("  --max-model-bytes N     MTP-only size gate (default 8589934592)\n");
    std::printf("  --timeout-ms N          socket timeout (default 10000)\n");
    std::printf("  --protocol-self-test    run codec tests without a model or network\n");
    std::printf("  --no-model-smoke        validate CLI defaults without a model or network\n");
    std::printf("  -h, --help              show this help\n");
}

uint64_t parse_u64(const std::string & text, const char * name) {
    size_t used = 0;
    const unsigned long long value = std::stoull(text, &used);
    if (used != text.size()) throw std::runtime_error(std::string("invalid ") + name);
    return (uint64_t) value;
}

uint32_t parse_u32(const std::string & text, const char * name) {
    const uint64_t value = parse_u64(text, name);
    if (value > UINT32_MAX) throw std::runtime_error(std::string("invalid ") + name);
    return (uint32_t) value;
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
        else if (arg == "--host") result.host = value(i, arg.c_str());
        else if (arg == "--port") result.port = value(i, arg.c_str());
        else if (arg == "--worker-id") result.worker_id = value(i, arg.c_str());
        else if (arg == "--model-sha") result.model_sha = value(i, arg.c_str());
        else if (arg == "--worker-digest") result.worker_digest = value(i, arg.c_str());
        else if (arg == "--device") result.device = value(i, arg.c_str());
        else if (arg == "--max-pos") result.max_pos = parse_u32(value(i, arg.c_str()), "max-pos");
        else if (arg == "--max-model-bytes") result.max_model_bytes = parse_u64(value(i, arg.c_str()), "max-model-bytes");
        else if (arg == "--timeout-ms") {
            const uint32_t timeout_ms = parse_u32(value(i, arg.c_str()), "timeout-ms");
            if (timeout_ms > INT_MAX) throw std::runtime_error("timeout-ms exceeds INT_MAX");
            result.timeout_ms = (int) timeout_ms;
        }
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
        if (tag.find("rpc") != std::string::npos) continue;
        const bool is_metal = tag.find("metal") != std::string::npos || tag.find("mtl") != std::string::npos;
        if (tag.find("cuda") == std::string::npos && !is_metal) continue;
        if (!requested.empty() && requested != name) continue;
        const auto type = ggml_backend_dev_type(dev);
        const bool metal_accel = is_metal && type == GGML_BACKEND_DEVICE_TYPE_ACCEL; // Apple Silicon Metal reports ACCEL
        if (type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU && !metal_accel) continue;
        if (selected) throw std::runtime_error("device name is ambiguous: " + requested);
        selected = dev;
        if (requested.empty()) break;
    }
    if (!selected) throw std::runtime_error("no matching direct local CUDA/Metal device; RPC and CPU are not allowed");
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

struct worker {
    const options & opts;
    model_ptr model;
    context_ptr ctx;
    llama_batch batch{};
    int32_t vocab = 0;
    std::array<int64_t, MAX_SEQS> last_pos{{-1, -1}};

    worker(const options & opts, ggml_backend_dev_t dev, const std::string & backend) : opts(opts) {
        std::array<ggml_backend_dev_t, 2> devices{{dev, nullptr}};
        llama_model_params mp = llama_model_default_params();
        mp.devices = devices.data();
        mp.n_gpu_layers = -1;
        mp.split_mode = LLAMA_SPLIT_MODE_NONE;
        mp.load_mtp = true;
        model.reset(llama_model_load_from_file(opts.model.c_str(), mp));
        if (!model) throw std::runtime_error("failed to load worker model");

        if (model_meta(model.get(), "general.architecture") != "qwen4exp") throw std::runtime_error("worker model gate failed: architecture is not qwen4exp");
        if (llama_model_n_embd_out(model.get()) != (int32_t) HIDDEN_WIDTH) throw std::runtime_error("worker model gate failed: hidden width is not 10240");
        if (llama_model_n_layer_nextn(model.get()) != 1) throw std::runtime_error("worker model gate failed: expected one MTP layer");
        if (llama_model_size(model.get()) == 0 || llama_model_size(model.get()) > opts.max_model_bytes) throw std::runtime_error("worker MTP-only model-size gate failed");
        if (lower(backend).find("cuda") != std::string::npos) {
            const std::string ftype = llama_ftype_name(llama_model_ftype(model.get()));
            if (ftype.rfind("Q4", 0) != 0) throw std::runtime_error("worker CUDA model gate failed: direct worker must be Q4");
        }
        vocab = llama_vocab_n_tokens(llama_model_get_vocab(model.get()));
        if (vocab <= 0) throw std::runtime_error("worker model has invalid vocabulary");

        llama_context_params cp = llama_context_default_params();
        cp.n_ctx = opts.max_pos;
        cp.n_batch = MAX_SEQS*MAX_ROWS;
        cp.n_ubatch = MAX_SEQS*MAX_ROWS;
        cp.n_seq_max = MAX_SEQS;
        cp.n_rs_seq = 0;
        cp.n_outputs_max = MAX_SEQS*MAX_ROWS;
        cp.n_outputs_max_per_seq = MAX_ROWS;
        cp.ctx_type = LLAMA_CONTEXT_TYPE_MTP;
        cp.no_perf = false;
        ctx.reset(llama_init_from_model(model.get(), cp));
        if (!ctx) throw std::runtime_error("failed to create MTP worker context");
        llama_set_embeddings_nextn(ctx.get(), false, false);

        batch = llama_batch_init(MAX_SEQS*MAX_ROWS, HIDDEN_WIDTH, 1);
        batch.token = (llama_token *) std::malloc(sizeof(llama_token)*MAX_SEQS*MAX_ROWS);
        if (!batch.token) throw std::bad_alloc();
    }

    ~worker() {
        std::free(batch.token);
        batch.token = nullptr;
        llama_batch_free(batch);
    }

    decode_schedule validate(const infer_request & request) const {
        const decode_schedule schedule = schedule_decode_rows(request.sequences, last_pos, opts.max_pos);
        for (const auto & seq : request.sequences) {
            for (const auto & item : seq.rows) {
                if (item.token < 0 || item.token >= vocab) throw std::runtime_error("token is outside vocabulary");
                if (item.hidden.size() != HIDDEN_WIDTH) throw std::runtime_error("hidden width mismatch");
                for (float x : item.hidden) if (!std::isfinite(x)) throw std::runtime_error("hidden row contains non-finite value");
            }
        }
        return schedule;
    }

    infer_response infer(const infer_request & request, uint64_t queue_us) {
        const decode_schedule schedule = validate(request);
        common_batch_clear(batch);
        for (const auto & scheduled : schedule.rows) {
            const auto & seq = request.sequences[scheduled.sequence_index];
            const auto & item = seq.rows[scheduled.row_index];
            common_batch_add(batch, item.token, (llama_pos) item.pos, {(llama_seq_id) seq.seq_id}, true);
            const int32_t i = batch.n_tokens - 1;
            std::memcpy(batch.embd + (size_t) i*HIDDEN_WIDTH, item.hidden.data(), HIDDEN_WIDTH*sizeof(float));
        }
        const uint64_t start = now_us();
        const int rc = llama_decode(ctx.get(), batch);
        if (rc != 0) throw std::runtime_error("MTP decode failed with code " + std::to_string(rc));
        llama_synchronize(ctx.get());
        infer_response response;
        response.campaign_epoch = request.campaign_epoch;
        response.msg_id = request.msg_id;
        response.compute_us = now_us() - start;
        response.queue_us = queue_us;
        for (const auto & seq : request.sequences) {
            const float * logits = llama_get_logits_ith(ctx.get(), schedule.last_output_index[seq.seq_id]);
            if (!logits) throw std::runtime_error("MTP logits are unavailable");
            int32_t best = 0;
            for (int32_t token = 1; token < vocab; ++token) if (logits[token] > logits[best]) best = token;
            const double max_logit = logits[best];
            double denom = 0;
            for (int32_t token = 0; token < vocab; ++token) denom += std::exp((double) logits[token] - max_logit);
            const float probability = (float) (1.0/denom);
            if (!std::isfinite(probability)) throw std::runtime_error("MTP probability is non-finite");
            response.proposals.push_back({seq.seq_id, best, probability});
            last_pos[seq.seq_id] = (int64_t) seq.rows.back().pos;
        }
        return response;
    }

    void reset(uint8_t mask) {
        if (mask == 0 || (mask & ~0x3u)) throw std::runtime_error("invalid reset sequence mask");
        for (uint8_t seq = 0; seq < MAX_SEQS; ++seq) {
            if (mask & (1u << seq)) {
                if (!llama_memory_seq_rm(llama_get_memory(ctx.get()), seq, -1, -1)) throw std::runtime_error("failed to clear worker sequence");
                last_pos[seq] = -1;
            }
        }
    }
};

uint64_t incarnation_id() {
    const uint64_t time = (uint64_t) std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
#ifdef _WIN32
    return time ^ (uint64_t) _getpid();
#else
    return time ^ (uint64_t) getpid();
#endif
}

int serve(worker & state, const options & opts) {
    socket_handle listener = listen_tcp(opts.host, opts.port, opts.timeout_ms);
    std::fprintf(stderr, "llama-mtp-worker-server: listening on %s:%s\n", opts.host.c_str(), opts.port.c_str());
    socket_handle client = accept_one(listener.get(), opts.timeout_ms);

    const frame hello_frame = recv_frame(client.get());
    if (hello_frame.type != message_type::hello_request) throw std::runtime_error("first message is not a handshake");
    const hello_request hello = decode_hello_request(hello_frame.payload);
    if (hello.campaign_epoch == 0 || hello.required_features != REQUIRED_FEATURES || hello.model_sha != opts.model_sha ||
        hello.protocol_digest != PROTOCOL_DIGEST || hello.expected_worker_id != opts.worker_id) {
        send_frame(client.get(), message_type::error_response, encode_error("handshake identity or feature mismatch"));
        throw std::runtime_error("handshake identity or feature mismatch");
    }
    hello_response attestation;
    attestation.hidden_width = HIDDEN_WIDTH;
    attestation.vocab = state.vocab;
    attestation.supported_features = REQUIRED_FEATURES;
    attestation.incarnation = incarnation_id();
    attestation.model_sha = opts.model_sha;
    attestation.protocol_digest = PROTOCOL_DIGEST;
    attestation.worker_id = opts.worker_id;
    attestation.worker_digest = opts.worker_digest;
    send_frame(client.get(), message_type::hello_response, encode(attestation));

    uint64_t next_msg_id = 1;
    bool has_cached = false;
    uint64_t cached_msg_id = 0;
    message_type cached_request_type = message_type::error_response;
    uint64_t cached_request_digest = 0;
    message_type cached_response_type = message_type::error_response;
    std::vector<uint8_t> cached_response_payload;
    for (;;) {
        frame request_frame = recv_frame(client.get());
        const uint64_t queued_at = now_us();
        uint64_t epoch = 0;
        uint64_t msg_id = 0;
        const uint64_t request_digest = fnv1a64(request_frame.payload.data(), request_frame.payload.size());
        if (request_frame.type == message_type::infer_request) {
            const infer_request request = decode_infer_request(request_frame.payload);
            epoch = request.campaign_epoch; msg_id = request.msg_id;
            if (epoch != hello.campaign_epoch) throw std::runtime_error("campaign epoch changed");
            if (has_cached && msg_id == cached_msg_id) {
                if (request_frame.type != cached_request_type || request_digest != cached_request_digest) throw std::runtime_error("conflicting duplicate message id");
                send_frame(client.get(), cached_response_type, cached_response_payload);
                continue;
            }
            if (msg_id != next_msg_id) throw std::runtime_error(msg_id < next_msg_id ? "stale message id" : "message id gap");
            const infer_response response = state.infer(request, now_us() - queued_at);
            cached_response_type = message_type::infer_response;
            cached_response_payload = encode(response);
        } else if (request_frame.type == message_type::reset_request) {
            const reset_request request = decode_reset_request(request_frame.payload);
            epoch = request.campaign_epoch; msg_id = request.msg_id;
            if (epoch != hello.campaign_epoch) throw std::runtime_error("campaign epoch changed");
            if (has_cached && msg_id == cached_msg_id) {
                if (request_frame.type != cached_request_type || request_digest != cached_request_digest) throw std::runtime_error("conflicting duplicate message id");
                send_frame(client.get(), cached_response_type, cached_response_payload);
                continue;
            }
            if (msg_id != next_msg_id) throw std::runtime_error(msg_id < next_msg_id ? "stale message id" : "message id gap");
            state.reset(request.sequence_mask);
            cached_response_type = message_type::reset_response;
            cached_response_payload = encode(reset_response{epoch, msg_id, request.sequence_mask});
        } else {
            throw std::runtime_error("unexpected message type");
        }
        has_cached = true;
        cached_msg_id = msg_id;
        cached_request_type = request_frame.type;
        cached_request_digest = request_digest;
        ++next_msg_id;
        send_frame(client.get(), cached_response_type, cached_response_payload);
    }
}

} // namespace

int main(int argc, char ** argv) {
    try {
        bool help = false;
        const options opts = parse_options(argc, argv, help);
        if (help) { usage(argv[0]); return 0; }
        if (opts.self_test) {
            std::string error;
            if (!protocol_self_test(error)) throw std::runtime_error("protocol self-test failed: " + error);
            std::puts("{\"protocol_self_test\":\"ok\"}");
            return 0;
        }
        if (opts.no_model_smoke) {
            if (opts.max_pos == 0 || opts.max_pos > INT32_MAX || opts.max_model_bytes == 0 || opts.timeout_ms <= 0 || opts.port.empty()) throw std::runtime_error("invalid smoke-test options");
            std::puts("{\"no_model_smoke\":\"ok\",\"max_sequences\":2,\"hidden_width\":10240,\"hidden_wire\":\"f16le\"}");
            return 0;
        }
        if (opts.model.empty() || opts.worker_id.empty() || opts.model_sha.empty() || opts.worker_digest.empty()) {
            usage(argv[0]);
            throw std::runtime_error("--model, --worker-id, --model-sha, and --worker-digest are required");
        }
        if (opts.max_pos == 0 || opts.max_pos > INT32_MAX || opts.max_model_bytes == 0 || opts.timeout_ms <= 0) throw std::runtime_error("max-pos, max-model-bytes, and timeout-ms are invalid");

        llama_backend_init();
        const selected_device device = select_local_device(opts.device);
        std::fprintf(stderr, "llama-mtp-worker-server: direct device %s (%s)\n", ggml_backend_dev_name(device.dev), device.backend.c_str());
        int result = 0;
        {
            worker state(opts, device.dev, device.backend);
            result = serve(state, opts);
        }
        llama_backend_free();
        return result;
    } catch (const std::exception & e) {
        std::fprintf(stderr, "llama-mtp-worker-server: %s\n", e.what());
        return 1;
    }
}
