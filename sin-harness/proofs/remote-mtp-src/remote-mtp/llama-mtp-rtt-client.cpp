#include "remote-mtp-protocol.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

using namespace remote_mtp;

namespace {

static constexpr int N_WORKERS = 2;

struct options {
    std::array<std::string, N_WORKERS> endpoints{{"127.0.0.1:50051", "127.0.0.1:50052"}};
    std::array<std::string, N_WORKERS> worker_ids{{"worker0", "worker1"}};
    std::array<std::string, N_WORKERS> worker_digests;
    std::string model_sha;
    uint32_t require_vocab = 0;
    uint32_t rows_per_worker = 2;
    uint32_t rounds = 20;
    uint32_t warmups = 3;
    uint32_t timeout_ms = 10000;
    uint32_t barrier_timeout_ms = 120000;
    std::string ready_file;
    std::string start_file;
    bool self_test = false;
    bool no_model_smoke = false;
};

void usage(const char * argv0) {
    std::printf("usage: %s --endpoints E0,E1 --model-sha SHA --worker-digests D0,D1 --require-vocab N [options]\n", argv0);
    std::printf("  --worker-id0 ID         expected worker 0 identity (default worker0)\n");
    std::printf("  --worker-id1 ID         expected worker 1 identity (default worker1)\n");
    std::printf("  --rows-per-worker N     one row on each of N distinct worker sequences; 1 or 2 (default 2)\n");
    std::printf("  --rounds N              measured concurrent phases (default 20)\n");
    std::printf("  --warmups N             untimed concurrent phases (default 3)\n");
    std::printf("  --timeout-ms N          connect/send/receive timeout (default 10000)\n");
    std::printf("  --ready-file PATH       atomically published after all warmups; requires --start-file\n");
    std::printf("  --start-file PATH       shared measured-phase release marker; requires --ready-file\n");
    std::printf("  --barrier-timeout-ms N  bounded start-file wait (default 120000)\n");
    std::printf("  --protocol-self-test    run protocol codec tests without a network\n");
    std::printf("  --no-model-smoke        validate CLI defaults without a network\n");
    std::printf("  -h, --help              show this help\n");
}

std::array<std::string, N_WORKERS> split_pair(const std::string & value, const char * name) {
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
        else if (arg == "--endpoints") result.endpoints = split_pair(value(i, arg.c_str()), "endpoints");
        else if (arg == "--endpoint0") result.endpoints[0] = value(i, arg.c_str());
        else if (arg == "--endpoint1") result.endpoints[1] = value(i, arg.c_str());
        else if (arg == "--worker-id0") result.worker_ids[0] = value(i, arg.c_str());
        else if (arg == "--worker-id1") result.worker_ids[1] = value(i, arg.c_str());
        else if (arg == "--worker-digest") {
            const std::string digest = value(i, arg.c_str());
            result.worker_digests = {{digest, digest}};
        }
        else if (arg == "--worker-digests") result.worker_digests = split_pair(value(i, arg.c_str()), "worker-digests");
        else if (arg == "--model-sha") result.model_sha = value(i, arg.c_str());
        else if (arg == "--require-vocab") result.require_vocab = parse_u32(value(i, arg.c_str()), "require-vocab");
        else if (arg == "--rows-per-worker") result.rows_per_worker = parse_u32(value(i, arg.c_str()), "rows-per-worker");
        else if (arg == "--rounds") result.rounds = parse_u32(value(i, arg.c_str()), "rounds");
        else if (arg == "--warmups") result.warmups = parse_u32(value(i, arg.c_str()), "warmups");
        else if (arg == "--timeout-ms") result.timeout_ms = parse_u32(value(i, arg.c_str()), "timeout-ms");
        else if (arg == "--ready-file") result.ready_file = value(i, arg.c_str());
        else if (arg == "--start-file") result.start_file = value(i, arg.c_str());
        else if (arg == "--barrier-timeout-ms") result.barrier_timeout_ms = parse_u32(value(i, arg.c_str()), "barrier-timeout-ms");
        else if (arg == "--protocol-self-test") result.self_test = true;
        else if (arg == "--no-model-smoke") result.no_model_smoke = true;
        else throw std::runtime_error("unknown option: " + arg);
    }
    return result;
}

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
        std::array<bool, MAX_SEQS> seen{{false, false}};
        for (size_t i = 0; i < response.proposals.size(); ++i) {
            const auto & proposal = response.proposals[i];
            if (proposal.seq_id != request.sequences[i].seq_id || proposal.seq_id >= MAX_SEQS || seen[proposal.seq_id] ||
                proposal.token < 0 || (uint32_t) proposal.token >= vocab_ || !std::isfinite(proposal.probability) ||
                proposal.probability < 0 || proposal.probability > 1) {
                throw std::runtime_error("worker returned invalid or duplicate proposal");
            }
            seen[proposal.seq_id] = true;
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

struct worker_samples {
    std::vector<uint64_t> rtt_us;
    std::vector<uint64_t> compute_us;
    std::vector<uint64_t> queue_us;
    uint64_t tx_bytes = 0;
    uint64_t rx_bytes = 0;
};

uint64_t percentile(std::vector<uint64_t> values, double q) {
    if (values.empty()) throw std::runtime_error("cannot calculate percentile of empty samples");
    std::sort(values.begin(), values.end());
    const size_t index = (size_t) std::ceil(q*values.size()) - 1;
    return values[std::min(index, values.size() - 1)];
}

std::vector<float> deterministic_hidden(int worker, uint32_t seq, uint32_t pos) {
    std::vector<float> result(HIDDEN_WIDTH);
    uint64_t state = 0x9e3779b97f4a7c15ULL ^ ((uint64_t) worker << 48) ^ ((uint64_t) seq << 32) ^ pos;
    for (float & value : result) {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        const uint32_t bits = (uint32_t) ((state*0x2545f4914f6cdd1dULL) >> 40);
        value = (float) bits/16777216.0f - 0.5f;
    }
    return result;
}

std::vector<sequence_rows> make_request(int worker, uint32_t rows_per_worker, uint32_t pos, uint32_t vocab) {
    std::vector<sequence_rows> result;
    result.reserve(rows_per_worker);
    for (uint32_t seq = 0; seq < rows_per_worker; ++seq) {
        row item;
        item.pos = pos;
        item.token = (int32_t) ((1 + (uint32_t) worker*8191 + seq*4099 + pos) % vocab);
        item.hidden = deterministic_hidden(worker, seq, pos);
        result.push_back({(uint8_t) seq, {std::move(item)}});
    }
    return result;
}

std::string json_escape(const std::string & value) {
    std::string result;
    for (unsigned char c : value) {
        switch (c) {
            case '\"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\b': result += "\\b"; break;
            case '\f': result += "\\f"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
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

bool path_entry_exists(const std::filesystem::path & path) {
    std::error_code error;
    const auto status = std::filesystem::symlink_status(path, error);
    if (error == std::errc::no_such_file_or_directory) return false;
    if (error) throw std::runtime_error("failed to inspect barrier path " + path.string() + ": " + error.message());
    return status.type() != std::filesystem::file_type::not_found;
}

void publish_ready_and_wait(const options & opts, uint64_t epoch) {
    if (opts.ready_file.empty()) return;

    const std::filesystem::path ready(opts.ready_file);
    const std::filesystem::path start(opts.start_file);
    if (path_entry_exists(ready)) throw std::runtime_error("ready-file already exists: " + ready.string());

    std::filesystem::path temporary(opts.ready_file + ".tmp." + std::to_string(epoch));
    if (path_entry_exists(temporary)) throw std::runtime_error("ready-file temporary path already exists: " + temporary.string());
    {
        std::ofstream output(temporary, std::ios::binary | std::ios::out);
        if (!output) throw std::runtime_error("failed to create ready-file temporary path: " + temporary.string());
        output << "ready\n";
        output.close();
        if (!output) {
            std::error_code ignored;
            std::filesystem::remove(temporary, ignored);
            throw std::runtime_error("failed to write ready-file temporary path: " + temporary.string());
        }
    }

    std::error_code publish_error;
    std::filesystem::create_hard_link(temporary, ready, publish_error);
    std::error_code cleanup_error;
    std::filesystem::remove(temporary, cleanup_error);
    if (publish_error) throw std::runtime_error("failed to atomically publish ready-file " + ready.string() + ": " + publish_error.message());
    if (cleanup_error) throw std::runtime_error("failed to remove ready-file temporary path " + temporary.string() + ": " + cleanup_error.message());

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(opts.barrier_timeout_ms);
    while (true) {
        std::error_code exists_error;
        const bool exists = std::filesystem::exists(start, exists_error);
        if (exists_error) throw std::runtime_error("failed to inspect start-file " + start.string() + ": " + exists_error.message());
        if (exists) {
            std::error_code type_error;
            const bool regular = std::filesystem::is_regular_file(start, type_error);
            if (type_error) throw std::runtime_error("failed to inspect start-file type " + start.string() + ": " + type_error.message());
            if (!regular) throw std::runtime_error("start-file is not a regular file: " + start.string());
            return;
        }
        if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("timed out waiting for start-file: " + start.string());
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}

void validate_options(const options & opts, bool require_identity) {
    for (const auto & endpoint : opts.endpoints) (void) split_endpoint(endpoint);
    if (opts.endpoints[0] == opts.endpoints[1]) throw std::runtime_error("worker endpoints must be distinct");
    if (opts.worker_ids[0].empty() || opts.worker_ids[1].empty() || opts.worker_ids[0] == opts.worker_ids[1]) {
        throw std::runtime_error("worker IDs must be nonempty and distinct");
    }
    if (opts.rows_per_worker < 1 || opts.rows_per_worker > MAX_SEQS) throw std::runtime_error("rows-per-worker must be 1 or 2");
    if (opts.rounds == 0) throw std::runtime_error("rounds must be positive");
    if (opts.warmups + opts.rounds < opts.rounds) throw std::runtime_error("warmup and round count overflow");
    if (opts.timeout_ms == 0 || opts.timeout_ms > INT_MAX) throw std::runtime_error("timeout-ms is invalid");
    if (opts.barrier_timeout_ms == 0) throw std::runtime_error("barrier-timeout-ms must be positive");
    const bool has_ready = !opts.ready_file.empty();
    const bool has_start = !opts.start_file.empty();
    if (has_ready != has_start) throw std::runtime_error("--ready-file and --start-file must be provided together and be nonempty");
    if (has_ready) {
        const auto ready = std::filesystem::path(opts.ready_file).lexically_normal();
        const auto start = std::filesystem::path(opts.start_file).lexically_normal();
        if (ready == start) throw std::runtime_error("ready-file and start-file must be distinct");
        if (path_entry_exists(ready)) throw std::runtime_error("ready-file already exists: " + ready.string());
    }
    if (require_identity && (opts.model_sha.empty() || opts.worker_digests[0].empty() || opts.worker_digests[1].empty() || opts.require_vocab < 2)) {
        throw std::runtime_error("--model-sha, --worker-digest(s), and --require-vocab are required");
    }
}

void run_benchmark(const options & opts) {
    const uint64_t epoch = now_us();
    if (epoch == 0) throw std::runtime_error("campaign epoch is zero");
    std::array<std::unique_ptr<worker_client>, N_WORKERS> clients;
    for (int worker = 0; worker < N_WORKERS; ++worker) {
        clients[worker] = std::make_unique<worker_client>(opts.endpoints[worker], opts.worker_ids[worker], opts.worker_digests[worker],
                opts.model_sha, epoch, (int) opts.timeout_ms, opts.require_vocab);
    }
    if (clients[0]->incarnation() == clients[1]->incarnation()) throw std::runtime_error("workers reported equal incarnations");

    auto run_phase = [&](uint32_t pos) {
        std::array<std::future<rpc_result>, N_WORKERS> futures;
        const uint64_t phase_start = now_us();
        for (int worker = 0; worker < N_WORKERS; ++worker) {
            auto sequences = make_request(worker, opts.rows_per_worker, pos, opts.require_vocab);
            futures[worker] = std::async(std::launch::async, [&, worker, sequences = std::move(sequences)]() mutable {
                return clients[worker]->infer(std::move(sequences));
            });
        }
        std::array<rpc_result, N_WORKERS> results;
        for (int worker = 0; worker < N_WORKERS; ++worker) results[worker] = futures[worker].get();
        return std::make_pair(now_us() - phase_start, std::move(results));
    };

    for (uint32_t warmup = 0; warmup < opts.warmups; ++warmup) (void) run_phase(warmup);
    publish_ready_and_wait(opts, epoch);

    std::vector<uint64_t> phase_us;
    std::array<worker_samples, N_WORKERS> workers;
    for (uint32_t round = 0; round < opts.rounds; ++round) {
        auto result = run_phase(opts.warmups + round);
        phase_us.push_back(result.first);
        for (int worker = 0; worker < N_WORKERS; ++worker) {
            workers[worker].rtt_us.push_back(result.second[worker].rtt_us);
            workers[worker].compute_us.push_back(result.second[worker].response.compute_us);
            workers[worker].queue_us.push_back(result.second[worker].response.queue_us);
            workers[worker].tx_bytes += result.second[worker].tx_bytes;
            workers[worker].rx_bytes += result.second[worker].rx_bytes;
        }
    }

    const uint64_t bytes_per_worker_phase = workers[0].tx_bytes/opts.rounds;
    std::printf("{\n");
    std::printf("  \"benchmark\": \"remote-mtp-rtt-stage-probe\",\n");
    std::printf("  \"protocol\": {\"digest\": \"%s\", \"hiddenWire\": \"ieee-binary16-le\", \"rowsPerWorker\": %u, \"payloadInterpretation\": \"%s\"},\n",
            PROTOCOL_DIGEST, opts.rows_per_worker,
            opts.rows_per_worker == 2 ? "two-f16-rows-payload-proxy-for-one-f32-row; not-f32" : "one-f16-row; not-f32");
    std::printf("  \"config\": {\"workers\": 2, \"warmups\": %u, \"rounds\": %u, \"timeoutMs\": %u, \"hiddenWidth\": %u},\n",
            opts.warmups, opts.rounds, opts.timeout_ms, HIDDEN_WIDTH);
    std::printf("  \"barrier\": {\"enabled\": %s, \"readyFile\": \"%s\", \"startFile\": \"%s\", \"timeoutMs\": %u},\n",
            opts.ready_file.empty() ? "false" : "true", json_escape(opts.ready_file).c_str(), json_escape(opts.start_file).c_str(), opts.barrier_timeout_ms);
    std::printf("  \"phaseWallUs\": {\"p50\": %llu, \"p95\": %llu},\n",
            (unsigned long long) percentile(phase_us, 0.50), (unsigned long long) percentile(phase_us, 0.95));
    std::printf("  \"bytesPerWorkerPhase\": %llu,\n", (unsigned long long) bytes_per_worker_phase);
    std::printf("  \"workers\": [\n");
    for (int worker = 0; worker < N_WORKERS; ++worker) {
        std::printf("    {\"worker\": %d, \"incarnation\": %llu, \"requestRttUs\": {\"p50\": %llu, \"p95\": %llu}, \"computeUs\": {\"p50\": %llu, \"p95\": %llu}, \"queueUs\": {\"p50\": %llu, \"p95\": %llu}, \"txBytes\": %llu, \"rxBytes\": %llu}%s\n",
                worker, (unsigned long long) clients[worker]->incarnation(),
                (unsigned long long) percentile(workers[worker].rtt_us, 0.50), (unsigned long long) percentile(workers[worker].rtt_us, 0.95),
                (unsigned long long) percentile(workers[worker].compute_us, 0.50), (unsigned long long) percentile(workers[worker].compute_us, 0.95),
                (unsigned long long) percentile(workers[worker].queue_us, 0.50), (unsigned long long) percentile(workers[worker].queue_us, 0.95),
                (unsigned long long) workers[worker].tx_bytes, (unsigned long long) workers[worker].rx_bytes,
                worker + 1 == N_WORKERS ? "" : ",");
    }
    std::printf("  ]\n}\n");
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
            std::puts("{\"protocolSelfTest\":\"ok\"}");
            return 0;
        }
        validate_options(opts, !opts.no_model_smoke);
        if (opts.no_model_smoke) {
            std::printf("{\"noModelSmoke\":\"ok\",\"workers\":2,\"rowsPerWorker\":%u,\"hiddenWire\":\"ieee-binary16-le\",\"payloadInterpretation\":\"%s\",\"barrier\":{\"enabled\":%s,\"readyFile\":\"%s\",\"startFile\":\"%s\",\"timeoutMs\":%u}}\n",
                    opts.rows_per_worker,
                    opts.rows_per_worker == 2 ? "two-f16-rows-payload-proxy-for-one-f32-row; not-f32" : "one-f16-row; not-f32",
                    opts.ready_file.empty() ? "false" : "true", json_escape(opts.ready_file).c_str(), json_escape(opts.start_file).c_str(), opts.barrier_timeout_ms);
            return 0;
        }
        run_benchmark(opts);
        return 0;
    } catch (const std::exception & error) {
        std::fprintf(stderr, "llama-mtp-rtt-client: %s\n", error.what());
        return 1;
    }
}
