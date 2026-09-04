// llama-remote-mtp-fork-bench (v2: multi-arm, single model load)
//
// Exact remote-MTP n=1 speculative decoding for a hybrid recurrent/attention target using
// per-stream fork/commit/discard sequence handling instead of partial recurrent rollback or
// checkpoint serialization:
//
//   committed seq c  : state after every accepted token, never written speculatively
//   speculative seq t: seq_cp(c -> t) [copy-on-write, metadata only], decode [current, draft] on t
//   accept           : t becomes committed (seq id swap), old c is seq_rm'd
//   reject           : t is seq_rm'd; the already-known token is re-fed on c in the next phase
//                      together with the corrected token (2-token batch entry, no draft)
//
// Every active stream contributes exactly 2 tokens per verify batch (1 in target-only arms),
// so the recurrent memory's equal-length split never produces extra ubatches.
//
// Arms (--arms A,B2,A,B1,O2,A): the model is loaded once; every arm gets a fresh context.
//   A  : target-only reference, 1 token per stream per phase (control; repeated to detect drift)
//   Bg : remote Legion CUDA MTP workers over loopback SSH tunnels, g = 1 or 2 stream groups
//   Og : zero-network drafts taken from the first completed A arm's token ids, with a deterministic
//        wrong draft every --oracle-reject-every proposals (exactness + RTT = 0 upper bound)
// Scheduling: groups=1 verifies all four streams per phase (worker RTT serial); groups=2 alternates
// {0,1} and {2,3} so one group's drafts are in flight while the other group is verified.
// Remote workers are reset (all sequences) before every B arm; the connection and campaign epoch persist.

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
#include <fstream>
#include <future>
#include <iomanip>
#include <map>
#include <memory>
#include <mutex>
#include <numeric>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace remote_mtp;

namespace {

static constexpr int N_STREAMS = 4;
static constexpr int N_WORKERS = 2;
static constexpr int N_SEQ_MAX = 3*N_STREAMS; // committed + speculative + copy-on-write slack

enum class arm_kind { target_only, oracle, remote };

struct arm_spec {
    arm_kind kind = arm_kind::target_only;
    uint32_t groups = 1;
    std::string label;
};

struct options {
    std::string model;
    std::string arms = "A,B2,A,B1,O2,A";
    std::string out_dir;
    std::array<std::string, N_WORKERS> endpoints{{"127.0.0.1:52061", "127.0.0.1:52062"}};
    std::array<std::string, N_WORKERS> worker_ids{{"worker0", "worker1"}};
    std::array<std::string, N_WORKERS> worker_digests;
    std::string model_sha;
    std::string device;
    std::string require_arch = "qwen4exp";
    std::string require_ftype = "Q4";
    uint32_t oracle_reject_every = 16;
    uint32_t require_hidden = HIDDEN_WIDTH;
    uint32_t require_vocab = 0;
    uint32_t tokens = 128;
    uint32_t warmup = 2;
    uint32_t force_reject_cycles = 6;
    uint32_t ctx = 8192;
    uint32_t timeout_ms = 10000;
    bool self_test = false;
    bool no_model_smoke = false;
};

void usage(const char * argv0) {
    std::printf("usage: %s --model FILE --out-dir DIR [--arms LIST] [--endpoints E0,E1 --model-sha SHA --worker-digests D0,D1] [options]\n", argv0);
    std::printf("  --arms LIST             comma-separated arms: A (target-only), B1/B2 (remote, groups), O1/O2 (oracle, groups); default A,B2,A,B1,O2,A\n");
    std::printf("  --out-dir DIR           per-arm JSON files are written to DIR/<label>.json\n");
    std::printf("  --oracle-reject-every N deterministic wrong oracle draft every N proposals (default 16, 0 = never)\n");
    std::printf("  --endpoints E0,E1       persistent worker endpoints (loopback SSH tunnels), required for B arms\n");
    std::printf("  --worker-id0/1 ID       expected worker identities (default worker0/worker1)\n");
    std::printf("  --worker-digests D0,D1  expected per-worker build digests\n");
    std::printf("  --model-sha SHA         target model-set identity echoed by workers\n");
    std::printf("  --device NAME           direct CUDA or Metal target device\n");
    std::printf("  --tokens N              output tokens per stream (default 128)\n");
    std::printf("  --warmup N              untimed rounds after forced-reject rounds (default 2)\n");
    std::printf("  --force-reject-cycles N untimed rounds with forced wrong drafts (default 6)\n");
    std::printf("  --ctx N                 target context bound (default 8192)\n");
    std::printf("  --require-arch NAME     model architecture gate (default qwen4exp)\n");
    std::printf("  --require-ftype PREFIX  quantization gate (default Q4)\n");
    std::printf("  --require-hidden N      target hidden-width gate (default 10240)\n");
    std::printf("  --require-vocab N       optional exact vocabulary gate\n");
    std::printf("  --timeout-ms N          hard socket timeout (default 10000)\n");
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

std::vector<arm_spec> parse_arms(const std::string & text) {
    std::vector<arm_spec> result;
    std::map<std::string, int> counts;
    std::stringstream ss(text);
    std::string item;
    while (std::getline(ss, item, ',')) {
        if (item.empty()) continue;
        arm_spec spec;
        if (item == "A") { spec.kind = arm_kind::target_only; spec.groups = 1; }
        else if (item == "B1" || item == "B2") { spec.kind = arm_kind::remote; spec.groups = item[1] - '0'; }
        else if (item == "O1" || item == "O2") { spec.kind = arm_kind::oracle; spec.groups = item[1] - '0'; }
        else throw std::runtime_error("unknown arm: " + item);
        const int n = ++counts[item];
        if (item == "A") spec.label = "A" + std::to_string(n);
        else spec.label = n == 1 ? item : item + "-" + std::to_string(n);
        result.push_back(spec);
    }
    if (result.empty()) throw std::runtime_error("no arms given");
    return result;
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
        else if (arg == "--arms") result.arms = value(i, arg.c_str());
        else if (arg == "--out-dir") result.out_dir = value(i, arg.c_str());
        else if (arg == "--endpoint0") result.endpoints[0] = value(i, arg.c_str());
        else if (arg == "--endpoint1") result.endpoints[1] = value(i, arg.c_str());
        else if (arg == "--endpoints") result.endpoints = split_pair(value(i, arg.c_str()), "endpoints");
        else if (arg == "--worker-id0") result.worker_ids[0] = value(i, arg.c_str());
        else if (arg == "--worker-id1") result.worker_ids[1] = value(i, arg.c_str());
        else if (arg == "--worker-digest") { const std::string v = value(i, arg.c_str()); result.worker_digests = {{v, v}}; }
        else if (arg == "--worker-digests") result.worker_digests = split_pair(value(i, arg.c_str()), "worker-digests");
        else if (arg == "--model-sha") result.model_sha = value(i, arg.c_str());
        else if (arg == "--device") result.device = value(i, arg.c_str());
        else if (arg == "--oracle-reject-every") result.oracle_reject_every = parse_u32(value(i, arg.c_str()), "oracle-reject-every");
        else if (arg == "--tokens") result.tokens = parse_u32(value(i, arg.c_str()), "tokens");
        else if (arg == "--warmup") result.warmup = parse_u32(value(i, arg.c_str()), "warmup");
        else if (arg == "--force-reject-cycles") result.force_reject_cycles = parse_u32(value(i, arg.c_str()), "force-reject-cycles");
        else if (arg == "--ctx") result.ctx = parse_u32(value(i, arg.c_str()), "ctx");
        else if (arg == "--timeout-ms") result.timeout_ms = parse_u32(value(i, arg.c_str()), "timeout-ms");
        else if (arg == "--require-arch") result.require_arch = value(i, arg.c_str());
        else if (arg == "--require-ftype") result.require_ftype = value(i, arg.c_str());
        else if (arg == "--require-hidden") result.require_hidden = parse_u32(value(i, arg.c_str()), "require-hidden");
        else if (arg == "--require-vocab") result.require_vocab = parse_u32(value(i, arg.c_str()), "require-vocab");
        else if (arg == "--protocol-self-test") result.self_test = true;
        else if (arg == "--no-model-smoke") result.no_model_smoke = true;
        else throw std::runtime_error("unknown argument: " + arg);
    }
    return result;
}

std::string lower(std::string s) {
    for (auto & c : s) c = (char) std::tolower((unsigned char) c);
    return s;
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

    // One request at a time per connection: the worker requires strictly increasing message ids and
    // answers in order, so concurrent group requests are serialized here.
    rpc_result infer(std::vector<sequence_rows> sequences) {
        std::lock_guard<std::mutex> lock(mutex_);
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

    void reset_all() {
        std::lock_guard<std::mutex> lock(mutex_);
        const uint8_t mask = (uint8_t) ((1u << MAX_SEQS) - 1);
        reset_request request{epoch_, next_msg_id_++, mask};
        send_frame(fd_.get(), message_type::reset_request, encode(request));
        const frame response_frame = recv_frame(fd_.get());
        if (response_frame.type == message_type::error_response) throw std::runtime_error("worker reset failed: " + decode_error(response_frame.payload));
        if (response_frame.type != message_type::reset_response) throw std::runtime_error("worker sent invalid reset response");
        const reset_response response = decode_reset_response(response_frame.payload);
        if (response.campaign_epoch != epoch_ || response.msg_id != request.msg_id || response.sequence_mask != mask) {
            throw std::runtime_error("worker reset identity mismatch");
        }
    }

    uint64_t incarnation() const { return incarnation_; }

private:
    socket_handle fd_;
    std::mutex mutex_;
    uint64_t epoch_ = 0;
    uint64_t next_msg_id_ = 1;
    uint64_t incarnation_ = 0;
    uint32_t vocab_ = 0;
};

struct stream_state {
    int index = 0;
    int group = 0;
    int worker = 0;
    uint8_t worker_seq = 0;
    llama_seq_id committed = 0;
    llama_seq_id spec = 0;
    uint32_t prompt_len = 0;
    uint32_t pos = 0;                          // position of `current`
    llama_token current = LLAMA_TOKEN_NULL;    // known token at pos, not yet inside committed state
    std::vector<float> hidden;                 // target hidden at pos-1 (the output that produced `current`)
    std::optional<row> catch_up;               // row the worker still has to consume before `current`
    std::optional<llama_token> replay;         // token at pos-1 not yet inside committed state (after reject)
    bool draft_pending = false;                // a draft request for (pos, current) is in flight or computed
    std::vector<llama_token> output;
    uint64_t token_hash = 1469598103934665603ULL;
    uint64_t content_hash = 1469598103934665603ULL;
    uint64_t proposal_hash = 1469598103934665603ULL;
};

struct metrics {
    std::array<uint64_t, N_WORKERS> rtt_us{};
    std::array<uint64_t, N_WORKERS> compute_us{};
    std::array<uint64_t, N_WORKERS> queue_us{};
    std::array<uint64_t, N_WORKERS> tx_bytes{};
    std::array<uint64_t, N_WORKERS> rx_bytes{};
    std::array<uint64_t, N_WORKERS> calls{};
    std::array<std::vector<uint64_t>, N_WORKERS> rtt_samples;
    uint64_t verify_us = 0;
    uint64_t fork_us = 0;
    uint64_t commit_us = 0;
    uint64_t wait_us = 0;
    uint64_t proposals = 0;
    uint64_t accepted = 0;
    uint64_t forced_rejects = 0;
    uint64_t replay_entries = 0;
    uint64_t phases = 0;
    uint64_t tokens = 0;
    std::vector<uint64_t> phase_us;
    std::vector<uint64_t> wait_samples;
    std::vector<uint64_t> verify_samples;
    std::vector<uint64_t> batch_tokens;
    std::vector<float> natural_mismatch_margin;   // logit[greedy] - logit[proposal] at non-forced rejects
};

uint64_t percentile(std::vector<uint64_t> v, double p) {
    if (v.empty()) return 0;
    std::sort(v.begin(), v.end());
    const size_t idx = std::min(v.size() - 1, (size_t) (p*v.size()));
    return v[idx];
}

uint64_t mean_of(const std::vector<uint64_t> & v) {
    if (v.empty()) return 0;
    return std::accumulate(v.begin(), v.end(), (uint64_t) 0) / v.size();
}

struct target_model {
    model_ptr model;
    int32_t vocab = 0;
    int32_t hidden_width = 0;

    target_model(const options & opts, ggml_backend_dev_t dev) {
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
    }
};

struct target_context {
    context_ptr ctx;

    target_context(const target_model & tm, const options & opts) {
        llama_context_params cp = llama_context_default_params();
        cp.n_ctx = opts.ctx;
        cp.n_batch = 256;
        cp.n_ubatch = 64;
        cp.n_seq_max = N_SEQ_MAX;
        cp.kv_unified = true;
        cp.n_rs_seq = 0;
        cp.n_outputs_max = std::max(2*N_STREAMS, N_SEQ_MAX); // output_reserve(n_seq_max) runs at construction
        cp.n_outputs_max_per_seq = 2;
        cp.no_perf = false;
        ctx.reset(llama_init_from_model(tm.model.get(), cp));
        if (!ctx) throw std::runtime_error("failed to create target context");
        if (llama_n_rs_seq(ctx.get()) != 0) throw std::runtime_error("target context unexpectedly enabled n_rs_seq");
        if (llama_n_seq_max(ctx.get()) < (uint32_t) N_SEQ_MAX) throw std::runtime_error("target context n_seq_max is too small for fork/commit");
        llama_set_embeddings_nextn(ctx.get(), true, false);
    }
};

llama_token greedy(const float * logits, int32_t vocab) {
    if (!logits) throw std::runtime_error("target logits are unavailable");
    llama_token best = 0;
    for (llama_token token = 1; token < vocab; ++token) if (logits[token] > logits[best]) best = token;
    return best;
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

using oracle_ids = std::array<std::vector<llama_token>, N_STREAMS>;

class benchmark {
public:
    benchmark(const options & opts, const arm_spec & arm, const target_model & tm,
              std::array<std::shared_ptr<worker_client>, N_WORKERS> clients, const oracle_ids * oracle)
        : opts_(opts), arm_(arm), tm_(tm), target_(tm, opts), clients_(std::move(clients)) {
        const int per_group = N_STREAMS / (int) arm_.groups;
        for (int i = 0; i < N_STREAMS; ++i) {
            streams_[i].index = i;
            streams_[i].group = i / per_group;
            streams_[i].worker = i % N_WORKERS;
            streams_[i].worker_seq = (uint8_t) (i / N_WORKERS);
            streams_[i].committed = i;
            streams_[i].spec = i + N_STREAMS;
            streams_[i].hidden.resize(HIDDEN_WIDTH);
        }
        if (use_remote()) {
            for (int i = 0; i < N_WORKERS; ++i) {
                if (!clients_[i]) throw std::runtime_error("remote arm without worker clients");
                clients_[i]->reset_all();
            }
        }
        if (use_oracle()) {
            if (!oracle) throw std::runtime_error("oracle arm requires a completed target-only arm before it");
            oracle_ = *oracle;
        }
        prefill();
    }

    void run() {
        static const std::array<std::array<bool, N_STREAMS>, 6> patterns{{
            {{true, false, false, false}},
            {{false, true, false, false}},
            {{false, false, true, false}},
            {{false, false, false, true}},
            {{true, false, true, false}},
            {{false, true, false, true}},
        }};
        for (uint32_t g = 0; g < arm_.groups; ++g) launch_drafts((int) g);
        if (!target_only()) {
            for (uint32_t i = 0; i < opts_.force_reject_cycles; ++i) round(&patterns[i % patterns.size()], false);
        }
        for (uint32_t i = 0; i < opts_.warmup; ++i) round(nullptr, false);
        untimed_tokens_ = 0;
        for (const auto & stream : streams_) untimed_tokens_ += stream.output.size();
        const uint64_t start = now_us();
        while (!all_done()) round(nullptr, true);
        elapsed_us_ = now_us() - start;
    }

    oracle_ids outputs() const {
        oracle_ids result;
        for (int i = 0; i < N_STREAMS; ++i) result[i] = streams_[i].output;
        return result;
    }

    double tokens_per_second() const { return elapsed_us_ > 0 ? timed_.tokens / (elapsed_us_ / 1e6) : 0.0; }

    std::string summary() const {
        const uint64_t ph = std::max<uint64_t>(1, timed_.phases);
        char buf[512];
        std::snprintf(buf, sizeof(buf), "%s mode=%s groups=%u tok/s=%.3f phases=%llu tokens=%llu phase p50/p95=%.1f/%.1f ms verify p50/p95=%.1f/%.1f ms wait p50/p95=%.1f/%.1f ms batch=%llu acc=%.4f (%llu/%llu, forced %llu) replay=%llu natural_mismatch_margin max=%.4f",
                arm_.label.c_str(), mode_name(), arm_.groups, tokens_per_second(), (unsigned long long) timed_.phases, (unsigned long long) timed_.tokens,
                percentile(timed_.phase_us, 0.5)/1000.0, percentile(timed_.phase_us, 0.95)/1000.0,
                percentile(timed_.verify_samples, 0.5)/1000.0, percentile(timed_.verify_samples, 0.95)/1000.0,
                percentile(timed_.wait_samples, 0.5)/1000.0, percentile(timed_.wait_samples, 0.95)/1000.0,
                (unsigned long long) percentile(timed_.batch_tokens, 0.5),
                timed_.proposals ? (double) timed_.accepted/timed_.proposals : 0.0, (unsigned long long) timed_.accepted, (unsigned long long) timed_.proposals,
                (unsigned long long) timed_.forced_rejects, (unsigned long long) timed_.replay_entries,
                timed_.natural_mismatch_margin.empty() ? 0.0 : *std::max_element(timed_.natural_mismatch_margin.begin(), timed_.natural_mismatch_margin.end()));
        (void) ph;
        return buf;
    }

    void write_json(const std::string & path) const {
        FILE * f = std::fopen(path.c_str(), "w");
        if (!f) throw std::runtime_error("cannot write " + path);
        emit_json(f);
        std::fclose(f);
    }

private:
    const options & opts_;
    arm_spec arm_;
    const target_model & tm_;
    target_context target_;
    std::array<std::shared_ptr<worker_client>, N_WORKERS> clients_;
    std::array<stream_state, N_STREAMS> streams_;
    std::array<std::array<std::future<rpc_result>, N_WORKERS>, N_STREAMS> futures_; // indexed [group][worker]
    oracle_ids oracle_;
    uint64_t oracle_proposals_ = 0;
    metrics timed_;
    uint64_t elapsed_us_ = 0;
    uint64_t untimed_tokens_ = 0;

    bool target_only() const { return arm_.kind == arm_kind::target_only; }
    bool use_remote() const { return arm_.kind == arm_kind::remote; }
    bool use_oracle() const { return arm_.kind == arm_kind::oracle; }
    const char * mode_name() const { return target_only() ? "target-only" : use_oracle() ? "oracle-mtp-n1-fork" : "remote-mtp-n1-fork"; }
    llama_context * ctx() { return target_.ctx.get(); }
    llama_memory_t mem() { return llama_get_memory(ctx()); }

    bool all_done() const {
        for (const auto & stream : streams_) if (stream.output.size() < opts_.tokens) return false;
        return true;
    }

    void round(const std::array<bool, N_STREAMS> * force_reject, bool timed) {
        for (uint32_t g = 0; g < arm_.groups; ++g) phase((int) g, force_reject, timed);
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
            tokens[i] = common_tokenize(ctx(), prompts[i], true, true);
            if (tokens[i].empty()) throw std::runtime_error("fixed prefix tokenized to empty input");
            if (tokens[i].size() + 2*opts_.tokens + 32 >= opts_.ctx) throw std::runtime_error("fixed prefix and output exceed ctx bound");
            total += tokens[i].size();
        }
        if (total > llama_n_batch(ctx())) throw std::runtime_error("fixed prefixes exceed target batch capacity");
        llama_batch batch = llama_batch_init((int32_t) total, 0, 1);
        std::array<int32_t, N_STREAMS> last_index{};
        for (int seq = 0; seq < N_STREAMS; ++seq) {
            for (size_t pos = 0; pos < tokens[seq].size(); ++pos) {
                const bool last = pos + 1 == tokens[seq].size();
                common_batch_add(batch, tokens[seq][pos], (llama_pos) pos, {streams_[seq].committed}, last);
                if (last) last_index[seq] = batch.n_tokens - 1;
            }
        }
        if (llama_decode(ctx(), batch) != 0) { llama_batch_free(batch); throw std::runtime_error("target prefill decode failed"); }
        llama_synchronize(ctx());
        for (int seq = 0; seq < N_STREAMS; ++seq) {
            streams_[seq].current = greedy(llama_get_logits_ith(ctx(), last_index[seq]), tm_.vocab);
            const float * hidden = llama_get_embeddings_nextn_ith(ctx(), last_index[seq]);
            if (!hidden) { llama_batch_free(batch); throw std::runtime_error("target prefill hidden output is unavailable"); }
            std::memcpy(streams_[seq].hidden.data(), hidden, HIDDEN_WIDTH*sizeof(float));
            streams_[seq].prompt_len = (uint32_t) tokens[seq].size();
            streams_[seq].pos = streams_[seq].prompt_len;
        }
        llama_batch_free(batch);
    }

    bool wants_draft(const stream_state & st) const {
        return !target_only() && st.output.size() < opts_.tokens && !st.replay;
    }

    // Send the rows for every stream of `group` that will draft in its next phase.
    void launch_drafts(int group) {
        if (target_only()) return;
        for (int worker = 0; worker < N_WORKERS; ++worker) {
            std::vector<sequence_rows> sequences;
            for (auto & st : streams_) {
                if (st.group != group || st.worker != worker || !wants_draft(st)) continue;
                if (use_oracle()) { st.draft_pending = true; continue; }
                std::vector<row> rows;
                if (st.catch_up) {
                    rows.push_back(std::move(*st.catch_up));
                    st.catch_up.reset();
                }
                row current;
                current.pos = st.pos;
                current.token = st.current;
                current.hidden = st.hidden;
                rows.push_back(std::move(current));
                sequences.push_back({st.worker_seq, std::move(rows)});
                st.draft_pending = true;
            }
            if (sequences.empty() || use_oracle()) continue;
            futures_[group][worker] = std::async(std::launch::async, [this, worker, sequences = std::move(sequences)]() mutable {
                return clients_[worker]->infer(std::move(sequences));
            });
        }
    }

    llama_token oracle_proposal(const stream_state & st, bool & forced) {
        const uint32_t idx = st.pos + 1 - st.prompt_len;
        llama_token token = idx < oracle_[st.index].size() ? oracle_[st.index][idx] : 0;
        ++oracle_proposals_;
        forced = opts_.oracle_reject_every && oracle_proposals_ % opts_.oracle_reject_every == 0;
        if (forced) token = (token + 1) % tm_.vocab;
        return token;
    }

    void expect_pos_max(llama_seq_id seq, llama_pos expected, const char * what) {
        const llama_pos actual = llama_memory_seq_pos_max(mem(), seq);
        if (actual != expected) {
            throw std::runtime_error(std::string(what) + ": seq " + std::to_string(seq) + " pos_max=" + std::to_string(actual) +
                    " expected=" + std::to_string(expected));
        }
    }

    void append_output(stream_state & st, llama_token token) {
        st.output.push_back(token);
        st.token_hash = fnv1a64(&token, sizeof(token), st.token_hash);
        const std::string piece = common_token_to_piece(ctx(), token);
        st.content_hash = fnv1a64(piece.data(), piece.size(), st.content_hash);
    }

    void phase(int group, const std::array<bool, N_STREAMS> * force_reject, bool timed) {
        const uint64_t phase_start = now_us();
        std::array<bool, N_STREAMS> active{};
        std::array<bool, N_STREAMS> drafting{};
        std::array<bool, N_STREAMS> forced{};
        bool any = false;
        for (int s = 0; s < N_STREAMS; ++s) {
            const auto & st = streams_[s];
            active[s] = st.group == group && st.output.size() < opts_.tokens;
            drafting[s] = active[s] && st.draft_pending;
            if (active[s] && !target_only() && !st.replay && !st.draft_pending) throw std::runtime_error("stream expected a pending draft");
            any = any || active[s];
        }
        if (!any) return;

        // 1. collect drafts (in flight since the end of this group's previous phase)
        std::array<llama_token, N_STREAMS> proposals{};
        proposals.fill(LLAMA_TOKEN_NULL);
        const uint64_t wait_start = now_us();
        if (use_remote()) {
            for (int worker = 0; worker < N_WORKERS; ++worker) {
                auto & future = futures_[group][worker];
                if (!future.valid()) continue;
                rpc_result result = future.get();
                if (timed) {
                    timed_.rtt_us[worker] += result.rtt_us;
                    timed_.rtt_samples[worker].push_back(result.rtt_us);
                    timed_.compute_us[worker] += result.response.compute_us;
                    timed_.queue_us[worker] += result.response.queue_us;
                    timed_.tx_bytes[worker] += result.tx_bytes;
                    timed_.rx_bytes[worker] += result.rx_bytes;
                    ++timed_.calls[worker];
                }
                for (const auto & p : result.response.proposals) {
                    const int seq = p.seq_id*N_WORKERS + worker;
                    if (seq < 0 || seq >= N_STREAMS || !drafting[seq]) throw std::runtime_error("worker proposal mapped to a non-drafting sequence");
                    proposals[seq] = p.token;
                }
            }
        } else if (use_oracle()) {
            for (int s = 0; s < N_STREAMS; ++s) if (drafting[s]) proposals[s] = oracle_proposal(streams_[s], forced[s]);
        }
        const uint64_t wait_us = now_us() - wait_start;
        for (int s = 0; s < N_STREAMS; ++s) {
            if (!drafting[s]) continue;
            if (proposals[s] == LLAMA_TOKEN_NULL) throw std::runtime_error("no proposal for a drafting sequence");
            if (force_reject && (*force_reject)[s]) { proposals[s] = (proposals[s] + 1) % tm_.vocab; forced[s] = true; }
            streams_[s].draft_pending = false;
        }

        // 2. fork committed -> speculative for drafting streams (copy-on-write, metadata only)
        const uint64_t fork_start = now_us();
        for (int s = 0; s < N_STREAMS; ++s) {
            if (!drafting[s]) continue;
            auto & st = streams_[s];
            if (!llama_memory_seq_rm(mem(), st.spec, -1, -1)) throw std::runtime_error("speculative sequence clear failed");
            llama_memory_seq_cp(mem(), st.committed, st.spec, -1, -1);
            expect_pos_max(st.spec, (llama_pos) st.pos - 1, "fork");
        }
        const uint64_t fork_us = now_us() - fork_start;

        // 3. one verify batch: exactly 2 tokens per active stream (1 in target-only arms)
        llama_batch batch = llama_batch_init(2*N_STREAMS, 0, 1);
        std::array<int32_t, N_STREAMS> idx_a{};
        std::array<int32_t, N_STREAMS> idx_b{};
        idx_a.fill(-1); idx_b.fill(-1);
        for (int s = 0; s < N_STREAMS; ++s) {
            if (!active[s]) continue;
            auto & st = streams_[s];
            if (target_only()) {
                common_batch_add(batch, st.current, (llama_pos) st.pos, {st.committed}, true);
                idx_a[s] = batch.n_tokens - 1;
            } else if (st.replay) {
                expect_pos_max(st.committed, (llama_pos) st.pos - 2, "replay");
                common_batch_add(batch, *st.replay, (llama_pos) st.pos - 1, {st.committed}, false);
                common_batch_add(batch, st.current, (llama_pos) st.pos, {st.committed}, true);
                idx_a[s] = batch.n_tokens - 1;
            } else {
                common_batch_add(batch, st.current, (llama_pos) st.pos, {st.spec}, true);
                idx_a[s] = batch.n_tokens - 1;
                common_batch_add(batch, proposals[s], (llama_pos) st.pos + 1, {st.spec}, true);
                idx_b[s] = batch.n_tokens - 1;
            }
        }
        const int32_t batch_tokens = batch.n_tokens;
        const uint64_t verify_start = now_us();
        if (llama_decode(ctx(), batch) != 0) { llama_batch_free(batch); throw std::runtime_error("target verification decode failed"); }
        llama_synchronize(ctx());
        const uint64_t verify_us = now_us() - verify_start;

        // 4. read outputs, commit or discard
        uint64_t commit_us = 0;
        uint64_t phase_tokens = 0;
        for (int s = 0; s < N_STREAMS; ++s) {
            if (!active[s]) continue;
            auto & st = streams_[s];
            const size_t before = st.output.size();
            const float * la = llama_get_logits_ith(ctx(), idx_a[s]);
            const llama_token ya = greedy(la, tm_.vocab);
            if (target_only()) {
                append_output(st, st.current);
                st.current = ya;
                st.pos += 1;
                phase_tokens += st.output.size() - before;
                continue;
            }
            const float * ha = llama_get_embeddings_nextn_ith(ctx(), idx_a[s]);
            if (!ha) throw std::runtime_error("target hidden output is unavailable");
            if (st.replay) {
                // replay entry decoded on the committed sequence: state is exact, no draft to judge
                row cu;
                cu.pos = st.pos;
                cu.token = st.current;
                cu.hidden = st.hidden;
                st.catch_up = std::move(cu);
                append_output(st, st.current);
                st.replay.reset();
                st.hidden.assign(ha, ha + HIDDEN_WIDTH);
                st.current = ya;
                st.pos += 1;
                if (timed) ++timed_.replay_entries;
                phase_tokens += st.output.size() - before;
                continue;
            }
            const llama_token yb = greedy(llama_get_logits_ith(ctx(), idx_b[s]), tm_.vocab);
            const float * hb = llama_get_embeddings_nextn_ith(ctx(), idx_b[s]);
            if (!hb) throw std::runtime_error("target hidden output is unavailable");
            const bool accepted = proposals[s] == ya;
            st.proposal_hash = fnv1a64(&proposals[s], sizeof(proposals[s]), st.proposal_hash);
            append_output(st, st.current);
            const uint64_t commit_start = now_us();
            if (accepted) {
                if (st.output.size() < opts_.tokens) append_output(st, proposals[s]);
                if (!llama_memory_seq_rm(mem(), st.committed, -1, -1)) throw std::runtime_error("committed sequence release failed");
                std::swap(st.committed, st.spec);
                expect_pos_max(st.committed, (llama_pos) st.pos + 1, "commit");
                row cu;
                cu.pos = st.pos + 1;
                cu.token = proposals[s];
                cu.hidden.assign(ha, ha + HIDDEN_WIDTH);
                st.catch_up = std::move(cu);
                st.hidden.assign(hb, hb + HIDDEN_WIDTH);
                st.current = yb;
                st.pos += 2;
            } else {
                if (!llama_memory_seq_rm(mem(), st.spec, -1, -1)) throw std::runtime_error("speculative sequence discard failed");
                expect_pos_max(st.committed, (llama_pos) st.pos - 1, "discard");
                st.replay = st.current;
                st.hidden.assign(ha, ha + HIDDEN_WIDTH);
                st.current = ya;
                st.pos += 1;
            }
            commit_us += now_us() - commit_start;
            if (timed) {
                ++timed_.proposals;
                if (accepted) ++timed_.accepted;
                else if (forced[s]) ++timed_.forced_rejects;
                else timed_.natural_mismatch_margin.push_back(la[ya] - la[proposals[s]]);
            }
            phase_tokens += st.output.size() - before;
        }
        llama_batch_free(batch);

        // 5. immediately re-draft this group so the network overlaps the other group's phase
        launch_drafts(group);

        if (timed) {
            timed_.verify_us += verify_us;
            timed_.fork_us += fork_us;
            timed_.commit_us += commit_us;
            timed_.wait_us += wait_us;
            timed_.tokens += phase_tokens;
            timed_.batch_tokens.push_back((uint64_t) batch_tokens);
            timed_.verify_samples.push_back(verify_us);
            timed_.wait_samples.push_back(wait_us);
            timed_.phase_us.push_back(now_us() - phase_start);
            ++timed_.phases;
        }
    }

    void emit_json(FILE * f) const {
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
        std::vector<float> margins = timed_.natural_mismatch_margin;
        std::sort(margins.begin(), margins.end());
        const double margin_max = margins.empty() ? 0.0 : margins.back();
        const double margin_median = margins.empty() ? 0.0 : margins[margins.size()/2];
        std::fprintf(f, "{\n");
        std::fprintf(f, "  \"benchmark\": \"remote-mtp-fork-bench\", \"version\": 2,\n");
        std::fprintf(f, "  \"label\": \"%s\",\n", json_escape(arm_.label).c_str());
        std::fprintf(f, "  \"mode\": \"%s\",\n", mode_name());
        std::fprintf(f, "  \"schedule\": {\"groups\": %u, \"streamsPerGroup\": %d, \"draftLaunch\": \"end-of-phase\"},\n", arm_.groups, N_STREAMS / (int) arm_.groups);
        std::fprintf(f, "  \"state_handling\": {\"fork\": \"llama_memory_seq_cp copy-on-write\", \"commit\": \"seq-id swap + seq_rm(old committed)\", \"discard\": \"seq_rm(speculative)\", \"partialRollback\": false, \"checkpointSerialization\": false, \"kvUnified\": true, \"nSeqMax\": %d, \"nRsSeq\": 0, \"tokensPerStreamPerBatch\": %d},\n",
                N_SEQ_MAX, target_only() ? 1 : 2);
        std::fprintf(f, "  \"protocol_digest\": \"%s\",\n", PROTOCOL_DIGEST);
        std::fprintf(f, "  \"hidden_wire\": \"%s\",\n", use_remote() ? "ieee-binary16-le" : "none");
        std::fprintf(f, "  \"oracle\": {\"source\": \"%s\", \"rejectEvery\": %u},\n", use_oracle() ? "first-target-only-arm-in-process" : "", opts_.oracle_reject_every);
        std::fprintf(f, "  \"model_sha\": \"%s\",\n", json_escape(opts_.model_sha).c_str());
        std::fprintf(f, "  \"config\": {\"seqs\": %d, \"n\": 1, \"tokens_per_stream\": %u, \"warmup_rounds\": %u, \"force_reject_rounds\": %u, \"ctx\": %u, \"greedy\": true},\n",
                N_STREAMS, opts_.tokens, opts_.warmup, target_only() ? 0u : opts_.force_reject_cycles, opts_.ctx);
        std::fprintf(f, "  \"timed\": {\n");
        std::fprintf(f, "    \"elapsed_us\": %llu, \"phases\": %llu, \"tokens\": %llu, \"tokens_per_second\": %.6f,\n",
                (unsigned long long) elapsed_us_, (unsigned long long) timed_.phases, (unsigned long long) timed_.tokens, tokens_per_second());
        std::fprintf(f, "    \"phase_us\": {\"p50\": %llu, \"p95\": %llu, \"mean\": %llu},\n",
                (unsigned long long) percentile(timed_.phase_us, 0.50), (unsigned long long) percentile(timed_.phase_us, 0.95), (unsigned long long) mean_of(timed_.phase_us));
        std::fprintf(f, "    \"verify_us\": {\"p50\": %llu, \"p95\": %llu, \"mean\": %llu},\n",
                (unsigned long long) percentile(timed_.verify_samples, 0.50), (unsigned long long) percentile(timed_.verify_samples, 0.95), (unsigned long long) mean_of(timed_.verify_samples));
        std::fprintf(f, "    \"wait_us\": {\"p50\": %llu, \"p95\": %llu, \"mean\": %llu},\n",
                (unsigned long long) percentile(timed_.wait_samples, 0.50), (unsigned long long) percentile(timed_.wait_samples, 0.95), (unsigned long long) mean_of(timed_.wait_samples));
        std::fprintf(f, "    \"batch_tokens\": {\"p50\": %llu, \"max\": %llu},\n",
                (unsigned long long) percentile(timed_.batch_tokens, 0.50), (unsigned long long) percentile(timed_.batch_tokens, 1.0));
        std::fprintf(f, "    \"verify_us_total\": %llu, \"fork_us_total\": %llu, \"commit_us_total\": %llu, \"worker_wait_us_total\": %llu,\n",
                (unsigned long long) timed_.verify_us, (unsigned long long) timed_.fork_us, (unsigned long long) timed_.commit_us, (unsigned long long) timed_.wait_us);
        std::fprintf(f, "    \"acceptance\": {\"accepted\": %llu, \"proposals\": %llu, \"rate\": %.6f, \"forcedRejects\": %llu, \"naturalRejects\": %zu},\n",
                (unsigned long long) timed_.accepted, (unsigned long long) timed_.proposals,
                timed_.proposals ? (double) timed_.accepted/timed_.proposals : 0.0, (unsigned long long) timed_.forced_rejects, margins.size());
        std::fprintf(f, "    \"natural_mismatch_logit_margin\": {\"count\": %zu, \"median\": %.6f, \"max\": %.6f},\n", margins.size(), margin_median, margin_max);
        std::fprintf(f, "    \"replay_entries\": %llu\n", (unsigned long long) timed_.replay_entries);
        std::fprintf(f, "  },\n");
        std::fprintf(f, "  \"untimed_tokens\": %llu, \"total_tokens\": %llu,\n", (unsigned long long) untimed_tokens_, (unsigned long long) total_tokens);
        std::fprintf(f, "  \"workers\": [\n");
        if (use_remote()) {
            for (int i = 0; i < N_WORKERS; ++i) {
                std::fprintf(f, "    {\"id\": \"%s\", \"endpoint\": \"%s\", \"incarnation\": %llu, \"calls\": %llu, \"rtt_us\": {\"p50\": %llu, \"p95\": %llu, \"mean\": %llu}, \"rtt_us_total\": %llu, \"compute_us_total\": %llu, \"queue_us_total\": %llu, \"tx_bytes\": %llu, \"rx_bytes\": %llu}%s\n",
                        json_escape(opts_.worker_ids[i]).c_str(), json_escape(opts_.endpoints[i]).c_str(),
                        (unsigned long long) clients_[i]->incarnation(), (unsigned long long) timed_.calls[i],
                        (unsigned long long) percentile(timed_.rtt_samples[i], 0.50), (unsigned long long) percentile(timed_.rtt_samples[i], 0.95), (unsigned long long) mean_of(timed_.rtt_samples[i]),
                        (unsigned long long) timed_.rtt_us[i], (unsigned long long) timed_.compute_us[i], (unsigned long long) timed_.queue_us[i],
                        (unsigned long long) timed_.tx_bytes[i], (unsigned long long) timed_.rx_bytes[i], i + 1 == N_WORKERS ? "" : ",");
            }
        }
        std::fprintf(f, "  ],\n  \"streams\": [\n");
        for (int i = 0; i < N_STREAMS; ++i) {
            const auto & stream = streams_[i];
            std::string content;
            std::string ids;
            for (size_t k = 0; k < stream.output.size(); ++k) {
                content += common_token_to_piece(const_cast<llama_context *>(target_.ctx.get()), stream.output[k]);
                ids += (k ? "," : "") + std::to_string(stream.output[k]);
            }
            std::fprintf(f, "    {\"stream\": %d, \"group\": %d, \"worker\": %d, \"prompt_len\": %u, \"tokens\": %zu, \"token_hash\": \"%s\", \"content_hash\": \"%s\", \"proposal_hash\": \"%s\", \"ids\": [%s], \"content\": \"%s\"}%s\n",
                    i, stream.group, stream.worker, stream.prompt_len, stream.output.size(), hex64(stream.token_hash).c_str(), hex64(stream.content_hash).c_str(),
                    hex64(stream.proposal_hash).c_str(), ids.c_str(), json_escape(content).c_str(), i + 1 == N_STREAMS ? "" : ",");
        }
        std::fprintf(f, "  ],\n");
        std::fprintf(f, "  \"aggregate_hashes\": {\"token\": \"%s\", \"content\": \"%s\", \"proposal\": \"%s\"}\n",
                hex64(aggregate_token_hash).c_str(), hex64(aggregate_content_hash).c_str(), hex64(aggregate_proposal_hash).c_str());
        std::fprintf(f, "}\n");
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
            std::puts("{\"protocol_self_test\":\"ok\",\"benchmark\":\"remote-mtp-fork-bench\",\"version\":2}");
            return 0;
        }
        if (opts.tokens == 0 || opts.ctx == 0) throw std::runtime_error("tokens and ctx must be positive");
        const std::vector<arm_spec> arms = parse_arms(opts.arms);
        bool any_remote = false;
        bool any_oracle = false;
        for (const auto & arm : arms) { any_remote = any_remote || arm.kind == arm_kind::remote; any_oracle = any_oracle || arm.kind == arm_kind::oracle; }
        if (any_remote) {
            if (opts.endpoints[0] == opts.endpoints[1]) throw std::runtime_error("worker endpoints must be distinct");
            if (opts.worker_ids[0] == opts.worker_ids[1]) throw std::runtime_error("worker IDs must be distinct");
            if (opts.timeout_ms == 0 || opts.timeout_ms > INT_MAX) throw std::runtime_error("timeout-ms is invalid");
            for (const auto & endpoint : opts.endpoints) (void) split_endpoint(endpoint);
        }
        if (any_oracle) {
            bool seen_a = false;
            for (const auto & arm : arms) {
                if (arm.kind == arm_kind::target_only) seen_a = true;
                if (arm.kind == arm_kind::oracle && !seen_a) throw std::runtime_error("an oracle arm must come after a target-only arm");
            }
        }
        if (opts.no_model_smoke) {
            std::string labels;
            for (const auto & arm : arms) labels += (labels.empty() ? "" : ",") + arm.label;
            std::printf("{\"no_model_smoke\":\"ok\",\"benchmark\":\"remote-mtp-fork-bench\",\"version\":2,\"arms\":\"%s\",\"seqs\":%d,\"n\":1,\"n_seq_max\":%d,\"kv_unified\":true,\"n_rs_seq\":0,\"hidden_width\":%u,\"hidden_wire\":\"%s\",\"rollback\":\"fork-commit-discard\"}\n",
                    labels.c_str(), N_STREAMS, N_SEQ_MAX, HIDDEN_WIDTH, any_remote ? "f16le" : "none");
            return 0;
        }
        if (opts.model.empty() || opts.out_dir.empty()) { usage(argv[0]); throw std::runtime_error("--model and --out-dir are required"); }
        if (any_remote && (opts.model_sha.empty() || opts.worker_digests[0].empty() || opts.worker_digests[1].empty())) {
            usage(argv[0]);
            throw std::runtime_error("--model-sha and --worker-digest(s) are required for remote arms");
        }
        llama_backend_init();
        const selected_device device = select_local_device(opts.device);
        std::fprintf(stderr, "llama-remote-mtp-fork-bench: direct target device %s (%s), PLE tensors forced to CPU, arms=%s\n",
                ggml_backend_dev_name(device.dev), device.backend.c_str(), opts.arms.c_str());
        {
            const uint64_t t_load = now_us();
            target_model tm(opts, device.dev);
            std::printf("MODEL_LOADED seconds=%.1f vocab=%d hidden=%d\n", (now_us() - t_load) / 1e6, tm.vocab, tm.hidden_width);
            std::fflush(stdout);
            std::array<std::shared_ptr<worker_client>, N_WORKERS> clients;
            if (any_remote) {
                uint64_t epoch = now_us() ^ ((uint64_t) tm.vocab << 32);
                if (epoch == 0) epoch = 1;
                for (int i = 0; i < N_WORKERS; ++i) {
                    clients[i] = std::make_shared<worker_client>(opts.endpoints[i], opts.worker_ids[i], opts.worker_digests[i],
                            opts.model_sha, epoch, (int) opts.timeout_ms, (uint32_t) tm.vocab);
                }
                if (clients[0]->incarnation() == clients[1]->incarnation()) throw std::runtime_error("workers reported equal incarnations");
                std::printf("WORKERS_CONNECTED incarnations=%llu,%llu\n", (unsigned long long) clients[0]->incarnation(), (unsigned long long) clients[1]->incarnation());
                std::fflush(stdout);
            }
            std::optional<oracle_ids> oracle;
            for (const auto & arm : arms) {
                const uint64_t t_arm = now_us();
                benchmark bench(opts, arm, tm, clients, oracle ? &*oracle : nullptr);
                bench.run();
                bench.write_json(opts.out_dir + "/" + arm.label + ".json");
                std::printf("ARM %s wall=%.1fs %s\n", arm.label.c_str(), (now_us() - t_arm) / 1e6, bench.summary().c_str());
                std::fflush(stdout);
                if (arm.kind == arm_kind::target_only && !oracle) oracle = bench.outputs();
            }
        }
        llama_backend_free();
        std::puts("ALL_ARMS_DONE");
        return 0;
    } catch (const std::exception & e) {
        std::fprintf(stderr, "llama-remote-mtp-fork-bench: %s\n", e.what());
        return 1;
    }
}
