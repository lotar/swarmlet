#pragma once

#include "ggml.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <winsock2.h>
#  include <ws2tcpip.h>
using mtp_socket_t = SOCKET;
static constexpr mtp_socket_t MTP_INVALID_SOCKET = INVALID_SOCKET;
#else
#  include <arpa/inet.h>
#  include <cerrno>
#  include <fcntl.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <poll.h>
#  include <sys/socket.h>
#  include <unistd.h>
using mtp_socket_t = int;
static constexpr mtp_socket_t MTP_INVALID_SOCKET = -1;
#endif

namespace remote_mtp {

static constexpr uint32_t MAGIC                     = 0x3150544d; // "MTP1" on the wire
static constexpr uint16_t VERSION                   = 2;
static constexpr uint32_t HIDDEN_WIDTH              = 10240;
static constexpr uint32_t HIDDEN_WIRE_BYTES         = HIDDEN_WIDTH*sizeof(uint16_t);
static constexpr uint32_t MAX_SEQS                  = 2;
static constexpr uint32_t MAX_ROWS                  = 2;
static constexpr uint32_t MAX_STRING                = 256;
static constexpr uint32_t MAX_INFER_REQUEST_PAYLOAD = 8 + 8 + 1 + MAX_SEQS*2 + MAX_SEQS*MAX_ROWS*(4 + 4 + HIDDEN_WIRE_BYTES);
static constexpr uint32_t MAX_PAYLOAD               = MAX_INFER_REQUEST_PAYLOAD;
static constexpr uint32_t FEATURE_HIDDEN_F16_LE     = 1u << 0;
static constexpr uint32_t REQUIRED_FEATURES         = FEATURE_HIDDEN_F16_LE;
static constexpr const char * PROTOCOL_DIGEST       = "remote-mtp-e2e-n1-f16le-partial-rs1-v2";

enum class message_type : uint16_t {
    hello_request  = 1,
    hello_response = 2,
    infer_request  = 3,
    infer_response = 4,
    reset_request  = 5,
    reset_response = 6,
    error_response = 7,
};

struct writer {
    std::vector<uint8_t> data;

    void u8(uint8_t v) { data.push_back(v); }
    void u16(uint16_t v) {
        data.push_back((uint8_t) v);
        data.push_back((uint8_t) (v >> 8));
    }
    void u32(uint32_t v) {
        for (int i = 0; i < 4; ++i) data.push_back((uint8_t) (v >> (8*i)));
    }
    void u64(uint64_t v) {
        for (int i = 0; i < 8; ++i) data.push_back((uint8_t) (v >> (8*i)));
    }
    void i32(int32_t v) { u32((uint32_t) v); }
    void f32(float v) {
        uint32_t bits = 0;
        static_assert(sizeof(bits) == sizeof(v), "float must be binary32");
        std::memcpy(&bits, &v, sizeof(bits));
        u32(bits);
    }
    void f16(float v) {
        if (!std::isfinite(v)) throw std::runtime_error("cannot encode non-finite binary16 value");
        const ggml_fp16_t value = ggml_fp32_to_fp16(v);
        if (!std::isfinite(ggml_fp16_to_fp32(value))) throw std::runtime_error("binary16 value overflow");
        u16((uint16_t) value);
    }
    void string(const std::string & v) {
        if (v.size() > MAX_STRING) throw std::runtime_error("protocol string is too long");
        u16((uint16_t) v.size());
        data.insert(data.end(), v.begin(), v.end());
    }
};

struct reader {
    const uint8_t * p = nullptr;
    size_t n = 0;
    size_t off = 0;

    explicit reader(const std::vector<uint8_t> & v) : p(v.data()), n(v.size()) {}

    void need(size_t count) {
        if (count > n - off) throw std::runtime_error("truncated protocol payload");
    }
    uint8_t u8() { need(1); return p[off++]; }
    uint16_t u16() {
        need(2);
        const uint16_t v = (uint16_t) p[off] | ((uint16_t) p[off + 1] << 8);
        off += 2;
        return v;
    }
    uint32_t u32() {
        need(4);
        uint32_t v = 0;
        for (int i = 0; i < 4; ++i) v |= (uint32_t) p[off + i] << (8*i);
        off += 4;
        return v;
    }
    uint64_t u64() {
        need(8);
        uint64_t v = 0;
        for (int i = 0; i < 8; ++i) v |= (uint64_t) p[off + i] << (8*i);
        off += 8;
        return v;
    }
    int32_t i32() { return (int32_t) u32(); }
    float f32() {
        const uint32_t bits = u32();
        float v = 0;
        std::memcpy(&v, &bits, sizeof(v));
        return v;
    }
    float f16() {
        const float v = ggml_fp16_to_fp32((ggml_fp16_t) u16());
        if (!std::isfinite(v)) throw std::runtime_error("decoded binary16 value is non-finite");
        return v;
    }
    std::string string() {
        const size_t len = u16();
        if (len > MAX_STRING) throw std::runtime_error("protocol string is too long");
        need(len);
        std::string result((const char *) p + off, len);
        off += len;
        return result;
    }
    void finish() {
        if (off != n) throw std::runtime_error("trailing protocol payload bytes");
    }
};

struct frame {
    message_type type = message_type::error_response;
    std::vector<uint8_t> payload;
};

inline std::vector<uint8_t> encode_frame(message_type type, const std::vector<uint8_t> & payload) {
    if (payload.size() > MAX_PAYLOAD) throw std::runtime_error("protocol payload exceeds limit");
    writer w;
    w.u32(MAGIC);
    w.u16(VERSION);
    w.u16((uint16_t) type);
    w.u32((uint32_t) payload.size());
    w.data.insert(w.data.end(), payload.begin(), payload.end());
    return std::move(w.data);
}

struct hello_request {
    uint64_t campaign_epoch = 0;
    uint32_t required_features = 0;
    std::string model_sha;
    std::string protocol_digest;
    std::string expected_worker_id;
};

struct hello_response {
    uint32_t hidden_width = 0;
    uint32_t vocab = 0;
    uint32_t supported_features = 0;
    uint64_t incarnation = 0;
    std::string model_sha;
    std::string protocol_digest;
    std::string worker_id;
    std::string worker_digest;
};

struct row {
    uint32_t pos = 0;
    int32_t token = 0;
    std::vector<float> hidden;
};

struct sequence_rows {
    uint8_t seq_id = 0;
    std::vector<row> rows;
};

struct infer_request {
    uint64_t campaign_epoch = 0;
    uint64_t msg_id = 0;
    std::vector<sequence_rows> sequences;
};

struct scheduled_row {
    size_t sequence_index = 0;
    size_t row_index = 0;
};

struct decode_schedule {
    std::vector<scheduled_row> rows;
    std::array<int32_t, MAX_SEQS> last_output_index{{-1, -1}};
};

inline decode_schedule schedule_decode_rows(const std::vector<sequence_rows> & sequences,
                                            const std::array<int64_t, MAX_SEQS> & last_pos,
                                            uint32_t max_pos) {
    if (sequences.empty() || sequences.size() > MAX_SEQS) throw std::runtime_error("invalid sequence count");
    std::array<bool, MAX_SEQS> seen{{false, false}};
    int previous_seq = -1;
    for (const auto & seq : sequences) {
        if (seq.seq_id >= MAX_SEQS || seen[seq.seq_id]) throw std::runtime_error("invalid or duplicate sequence identity");
        if ((int) seq.seq_id <= previous_seq) throw std::runtime_error("sequences are not in identity order");
        previous_seq = seq.seq_id;
        seen[seq.seq_id] = true;
        if (seq.rows.empty() || seq.rows.size() > MAX_ROWS) throw std::runtime_error("invalid row count");
        int64_t expected = last_pos[seq.seq_id] < 0 ? (int64_t) seq.rows[0].pos : last_pos[seq.seq_id] + 1;
        for (const auto & item : seq.rows) {
            if ((int64_t) item.pos != expected++) throw std::runtime_error("non-contiguous absolute position");
            if (item.pos >= max_pos) throw std::runtime_error("position exceeds max-pos");
        }
    }

    decode_schedule result;
    for (size_t row_index = 0; row_index < MAX_ROWS; ++row_index) {
        for (size_t sequence_index = 0; sequence_index < sequences.size(); ++sequence_index) {
            const auto & seq = sequences[sequence_index];
            if (row_index >= seq.rows.size()) continue;
            result.rows.push_back({sequence_index, row_index});
            result.last_output_index[seq.seq_id] = (int32_t) result.rows.size() - 1;
        }
    }
    return result;
}

struct proposal {
    uint8_t seq_id = 0;
    int32_t token = 0;
    float probability = 0;
};

struct infer_response {
    uint64_t campaign_epoch = 0;
    uint64_t msg_id = 0;
    uint64_t compute_us = 0;
    uint64_t queue_us = 0;
    std::vector<proposal> proposals;
};

struct reset_request {
    uint64_t campaign_epoch = 0;
    uint64_t msg_id = 0;
    uint8_t sequence_mask = 0;
};

struct reset_response {
    uint64_t campaign_epoch = 0;
    uint64_t msg_id = 0;
    uint8_t sequence_mask = 0;
};

inline std::vector<uint8_t> encode(const hello_request & v) {
    writer w;
    w.u64(v.campaign_epoch); w.u32(v.required_features); w.string(v.model_sha); w.string(v.protocol_digest); w.string(v.expected_worker_id);
    return std::move(w.data);
}
inline hello_request decode_hello_request(const std::vector<uint8_t> & b) {
    reader r(b); hello_request v;
    v.campaign_epoch = r.u64(); v.required_features = r.u32(); v.model_sha = r.string(); v.protocol_digest = r.string(); v.expected_worker_id = r.string(); r.finish();
    return v;
}
inline std::vector<uint8_t> encode(const hello_response & v) {
    writer w;
    w.u32(v.hidden_width); w.u32(v.vocab); w.u32(v.supported_features); w.u64(v.incarnation); w.string(v.model_sha); w.string(v.protocol_digest); w.string(v.worker_id); w.string(v.worker_digest);
    return std::move(w.data);
}
inline hello_response decode_hello_response(const std::vector<uint8_t> & b) {
    reader r(b); hello_response v;
    v.hidden_width = r.u32(); v.vocab = r.u32(); v.supported_features = r.u32(); v.incarnation = r.u64(); v.model_sha = r.string(); v.protocol_digest = r.string(); v.worker_id = r.string(); v.worker_digest = r.string(); r.finish();
    return v;
}
inline std::vector<uint8_t> encode(const infer_request & v) {
    if (v.sequences.empty() || v.sequences.size() > MAX_SEQS) throw std::runtime_error("invalid sequence count");
    writer w;
    w.u64(v.campaign_epoch); w.u64(v.msg_id); w.u8((uint8_t) v.sequences.size());
    for (const auto & seq : v.sequences) {
        if (seq.rows.empty() || seq.rows.size() > MAX_ROWS) throw std::runtime_error("invalid row count");
        w.u8(seq.seq_id); w.u8((uint8_t) seq.rows.size());
        for (const auto & item : seq.rows) {
            if (item.hidden.size() != HIDDEN_WIDTH) throw std::runtime_error("invalid hidden width");
            w.u32(item.pos); w.i32(item.token);
            for (float x : item.hidden) w.f16(x);
        }
    }
    return std::move(w.data);
}
inline infer_request decode_infer_request(const std::vector<uint8_t> & b) {
    reader r(b); infer_request v;
    v.campaign_epoch = r.u64(); v.msg_id = r.u64();
    const uint8_t n_seq = r.u8();
    if (n_seq == 0 || n_seq > MAX_SEQS) throw std::runtime_error("invalid sequence count");
    v.sequences.resize(n_seq);
    for (auto & seq : v.sequences) {
        seq.seq_id = r.u8();
        const uint8_t n_rows = r.u8();
        if (n_rows == 0 || n_rows > MAX_ROWS) throw std::runtime_error("invalid row count");
        seq.rows.resize(n_rows);
        for (auto & item : seq.rows) {
            item.pos = r.u32(); item.token = r.i32(); item.hidden.resize(HIDDEN_WIDTH);
            for (float & x : item.hidden) x = r.f16();
        }
    }
    r.finish();
    return v;
}
inline std::vector<uint8_t> encode(const infer_response & v) {
    if (v.proposals.empty() || v.proposals.size() > MAX_SEQS) throw std::runtime_error("invalid proposal count");
    writer w;
    w.u64(v.campaign_epoch); w.u64(v.msg_id); w.u64(v.compute_us); w.u64(v.queue_us); w.u8((uint8_t) v.proposals.size());
    for (const auto & p : v.proposals) { w.u8(p.seq_id); w.i32(p.token); w.f32(p.probability); }
    return std::move(w.data);
}
inline infer_response decode_infer_response(const std::vector<uint8_t> & b) {
    reader r(b); infer_response v;
    v.campaign_epoch = r.u64(); v.msg_id = r.u64(); v.compute_us = r.u64(); v.queue_us = r.u64();
    const uint8_t count = r.u8();
    if (count == 0 || count > MAX_SEQS) throw std::runtime_error("invalid proposal count");
    v.proposals.resize(count);
    for (auto & p : v.proposals) { p.seq_id = r.u8(); p.token = r.i32(); p.probability = r.f32(); }
    r.finish();
    return v;
}
inline std::vector<uint8_t> encode(const reset_request & v) {
    writer w; w.u64(v.campaign_epoch); w.u64(v.msg_id); w.u8(v.sequence_mask); return std::move(w.data);
}
inline reset_request decode_reset_request(const std::vector<uint8_t> & b) {
    reader r(b); reset_request v; v.campaign_epoch = r.u64(); v.msg_id = r.u64(); v.sequence_mask = r.u8(); r.finish(); return v;
}
inline std::vector<uint8_t> encode(const reset_response & v) {
    writer w; w.u64(v.campaign_epoch); w.u64(v.msg_id); w.u8(v.sequence_mask); return std::move(w.data);
}
inline reset_response decode_reset_response(const std::vector<uint8_t> & b) {
    reader r(b); reset_response v; v.campaign_epoch = r.u64(); v.msg_id = r.u64(); v.sequence_mask = r.u8(); r.finish(); return v;
}

inline std::vector<uint8_t> encode_error(const std::string & message) {
    writer w; w.string(message); return std::move(w.data);
}
inline std::string decode_error(const std::vector<uint8_t> & b) {
    reader r(b); std::string v = r.string(); r.finish(); return v;
}

inline void socket_close(mtp_socket_t fd) {
    if (fd == MTP_INVALID_SOCKET) return;
#ifdef _WIN32
    closesocket(fd);
#else
    close(fd);
#endif
}

class socket_handle {
public:
    socket_handle() = default;
    explicit socket_handle(mtp_socket_t fd) : fd_(fd) {}
    ~socket_handle() { socket_close(fd_); }
    socket_handle(const socket_handle &) = delete;
    socket_handle & operator=(const socket_handle &) = delete;
    socket_handle(socket_handle && other) noexcept : fd_(other.release()) {}
    socket_handle & operator=(socket_handle && other) noexcept {
        if (this != &other) { socket_close(fd_); fd_ = other.release(); }
        return *this;
    }
    mtp_socket_t get() const { return fd_; }
    explicit operator bool() const { return fd_ != MTP_INVALID_SOCKET; }
    mtp_socket_t release() { const auto result = fd_; fd_ = MTP_INVALID_SOCKET; return result; }
private:
    mtp_socket_t fd_ = MTP_INVALID_SOCKET;
};

inline void socket_runtime_init() {
#ifdef _WIN32
    static bool initialized = [] {
        WSADATA data{};
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) throw std::runtime_error("WSAStartup failed");
        return true;
    }();
    (void) initialized;
#endif
}

inline std::string socket_error(const char * what) {
#ifdef _WIN32
    return std::string(what) + " failed: " + std::to_string(WSAGetLastError());
#else
    return std::string(what) + " failed: " + std::strerror(errno);
#endif
}

inline void set_socket_options(mtp_socket_t fd, int timeout_ms) {
    int one = 1;
    if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, (const char *) &one, sizeof(one)) != 0) throw std::runtime_error(socket_error("TCP_NODELAY"));
#ifdef _WIN32
    DWORD timeout = (DWORD) timeout_ms;
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, (const char *) &timeout, sizeof(timeout)) != 0 ||
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, (const char *) &timeout, sizeof(timeout)) != 0) throw std::runtime_error(socket_error("socket timeout"));
#else
    timeval timeout{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0 ||
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0) throw std::runtime_error(socket_error("socket timeout"));
#endif
}

inline void send_all(mtp_socket_t fd, const uint8_t * data, size_t size) {
    while (size > 0) {
#ifdef _WIN32
        const int n = send(fd, (const char *) data, (int) std::min<size_t>(size, INT_MAX), 0);
#else
        const ssize_t n = send(fd, data, size, MSG_NOSIGNAL);
#endif
        if (n <= 0) throw std::runtime_error(socket_error("send"));
        data += n; size -= (size_t) n;
    }
}

inline void recv_all(mtp_socket_t fd, uint8_t * data, size_t size) {
    while (size > 0) {
#ifdef _WIN32
        const int n = recv(fd, (char *) data, (int) std::min<size_t>(size, INT_MAX), 0);
#else
        const ssize_t n = recv(fd, data, size, 0);
#endif
        if (n == 0) throw std::runtime_error("peer closed connection");
        if (n < 0) throw std::runtime_error(socket_error("recv"));
        data += n; size -= (size_t) n;
    }
}

inline void send_frame(mtp_socket_t fd, message_type type, const std::vector<uint8_t> & payload) {
    const auto bytes = encode_frame(type, payload);
    send_all(fd, bytes.data(), bytes.size());
}

inline frame recv_frame(mtp_socket_t fd) {
    std::array<uint8_t, 12> h{};
    recv_all(fd, h.data(), h.size());
    std::vector<uint8_t> hb(h.begin(), h.end());
    reader r(hb);
    if (r.u32() != MAGIC) throw std::runtime_error("bad protocol magic");
    if (r.u16() != VERSION) throw std::runtime_error("unsupported protocol version");
    const uint16_t raw_type = r.u16();
    const uint32_t len = r.u32();
    if (len > MAX_PAYLOAD) throw std::runtime_error("protocol payload exceeds limit");
    frame result{(message_type) raw_type, std::vector<uint8_t>(len)};
    if (len) recv_all(fd, result.payload.data(), len);
    return result;
}

inline std::pair<std::string, std::string> split_endpoint(const std::string & endpoint) {
    if (endpoint.empty()) throw std::runtime_error("empty endpoint");
    if (endpoint[0] == '[') {
        const size_t end = endpoint.find(']');
        if (end == std::string::npos || end + 2 > endpoint.size() || endpoint[end + 1] != ':') throw std::runtime_error("invalid bracketed endpoint");
        return {endpoint.substr(1, end - 1), endpoint.substr(end + 2)};
    }
    const size_t colon = endpoint.rfind(':');
    if (colon == std::string::npos || colon == 0 || colon + 1 == endpoint.size()) throw std::runtime_error("endpoint must be HOST:PORT");
    return {endpoint.substr(0, colon), endpoint.substr(colon + 1)};
}

inline bool connect_with_timeout(mtp_socket_t fd, const sockaddr * addr, socklen_t addrlen, int timeout_ms) {
#ifdef _WIN32
    u_long nonblocking = 1;
    if (ioctlsocket(fd, FIONBIO, &nonblocking) != 0) throw std::runtime_error(socket_error("ioctlsocket"));
    const int rc = connect(fd, addr, addrlen);
    if (rc != 0 && WSAGetLastError() != WSAEWOULDBLOCK && WSAGetLastError() != WSAEINPROGRESS) return false;
    if (rc != 0) {
        fd_set writes; FD_ZERO(&writes); FD_SET(fd, &writes);
        timeval timeout{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
        if (select(0, nullptr, &writes, nullptr, &timeout) <= 0) return false;
    }
    nonblocking = 0;
    if (ioctlsocket(fd, FIONBIO, &nonblocking) != 0) throw std::runtime_error(socket_error("ioctlsocket"));
#else
    const int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) throw std::runtime_error(socket_error("fcntl"));
    const int rc = connect(fd, addr, addrlen);
    if (rc != 0 && errno != EINPROGRESS) return false;
    if (rc != 0) {
        pollfd event{fd, POLLOUT, 0};
        if (poll(&event, 1, timeout_ms) <= 0) return false;
    }
    if (fcntl(fd, F_SETFL, flags) != 0) throw std::runtime_error(socket_error("fcntl"));
#endif
    int error = 0;
    socklen_t error_len = sizeof(error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, (char *) &error, &error_len) != 0 || error != 0) return false;
    return true;
}

inline socket_handle connect_tcp(const std::string & endpoint, int timeout_ms) {
    socket_runtime_init();
    const auto hp = split_endpoint(endpoint);
    addrinfo hints{}; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP;
    addrinfo * list = nullptr;
    const int gai = getaddrinfo(hp.first.c_str(), hp.second.c_str(), &hints, &list);
    if (gai != 0) throw std::runtime_error(std::string("getaddrinfo failed: ") + gai_strerror(gai));
    std::string last = "connect failed or timed out";
    for (addrinfo * it = list; it; it = it->ai_next) {
        socket_handle fd(socket(it->ai_family, it->ai_socktype, it->ai_protocol));
        if (!fd) continue;
        try {
            if (connect_with_timeout(fd.get(), it->ai_addr, (socklen_t) it->ai_addrlen, timeout_ms)) {
                set_socket_options(fd.get(), timeout_ms);
                freeaddrinfo(list);
                return fd;
            }
            last = socket_error("connect");
        } catch (const std::exception & e) { last = e.what(); }
    }
    freeaddrinfo(list);
    throw std::runtime_error(last);
}

inline socket_handle listen_tcp(const std::string & host, const std::string & port, int timeout_ms) {
    (void) timeout_ms;
    socket_runtime_init();
    addrinfo hints{}; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP; hints.ai_flags = AI_PASSIVE;
    addrinfo * list = nullptr;
    const char * node = host.empty() || host == "*" ? nullptr : host.c_str();
    const int gai = getaddrinfo(node, port.c_str(), &hints, &list);
    if (gai != 0) throw std::runtime_error(std::string("getaddrinfo failed: ") + gai_strerror(gai));
    std::string last = "bind failed";
    for (addrinfo * it = list; it; it = it->ai_next) {
        socket_handle fd(socket(it->ai_family, it->ai_socktype, it->ai_protocol));
        if (!fd) continue;
        int one = 1;
        setsockopt(fd.get(), SOL_SOCKET, SO_REUSEADDR, (const char *) &one, sizeof(one));
        if (bind(fd.get(), it->ai_addr, (socklen_t) it->ai_addrlen) == 0 && listen(fd.get(), 1) == 0) { freeaddrinfo(list); return fd; }
        last = socket_error("bind/listen");
    }
    freeaddrinfo(list);
    throw std::runtime_error(last);
}

inline socket_handle accept_one(mtp_socket_t listener, int timeout_ms) {
    socket_handle fd(accept(listener, nullptr, nullptr));
    if (!fd) throw std::runtime_error(socket_error("accept"));
    set_socket_options(fd.get(), timeout_ms);
    return fd;
}

inline uint64_t now_us() {
    return (uint64_t) std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

inline uint64_t fnv1a64(const void * ptr, size_t size, uint64_t hash = 1469598103934665603ULL) {
    const auto * p = (const uint8_t *) ptr;
    for (size_t i = 0; i < size; ++i) { hash ^= p[i]; hash *= 1099511628211ULL; }
    return hash;
}

inline bool protocol_self_test(std::string & error) {
    try {
        row hidden_row;
        hidden_row.hidden.resize(HIDDEN_WIDTH);
        for (size_t i = 0; i < hidden_row.hidden.size(); ++i) hidden_row.hidden[i] = (float) i * 0.0001f - 0.25f;
        hidden_row.hidden[0] = 1.0f;
        hidden_row.hidden[1] = -2.0f;

        const hello_request hello_in{0x0102030405060708ULL, REQUIRED_FEATURES, "model", PROTOCOL_DIGEST, "worker0"};
        const hello_request hello_out = decode_hello_request(encode(hello_in));
        if (hello_out.campaign_epoch != hello_in.campaign_epoch || hello_out.required_features != REQUIRED_FEATURES ||
            hello_out.model_sha != hello_in.model_sha || hello_out.protocol_digest != PROTOCOL_DIGEST || hello_out.expected_worker_id != hello_in.expected_worker_id) {
            throw std::runtime_error("hello feature round trip mismatch");
        }
        hello_response attestation_in;
        attestation_in.hidden_width = HIDDEN_WIDTH;
        attestation_in.vocab = 151936;
        attestation_in.supported_features = REQUIRED_FEATURES;
        attestation_in.incarnation = 42;
        attestation_in.model_sha = "model";
        attestation_in.protocol_digest = PROTOCOL_DIGEST;
        attestation_in.worker_id = "worker0";
        attestation_in.worker_digest = "digest";
        const hello_response attestation_out = decode_hello_response(encode(attestation_in));
        if (attestation_out.hidden_width != HIDDEN_WIDTH || attestation_out.vocab != attestation_in.vocab ||
            attestation_out.supported_features != REQUIRED_FEATURES || attestation_out.incarnation != attestation_in.incarnation ||
            attestation_out.protocol_digest != PROTOCOL_DIGEST || attestation_out.worker_digest != attestation_in.worker_digest) {
            throw std::runtime_error("hello attestation feature round trip mismatch");
        }

        std::array<int64_t, MAX_SEQS> last_pos{{9, 9}};
        infer_request cycle_one;
        cycle_one.campaign_epoch = 0x0102030405060708ULL;
        cycle_one.msg_id = 9;
        row first_zero = hidden_row; first_zero.pos = 10; first_zero.token = 100;
        row first_one = hidden_row; first_one.pos = 10; first_one.token = 200;
        cycle_one.sequences.push_back({0, {std::move(first_zero)}});
        cycle_one.sequences.push_back({1, {std::move(first_one)}});
        const auto first_schedule = schedule_decode_rows(cycle_one.sequences, last_pos, 32);
        if (first_schedule.rows.size() != 2 || first_schedule.last_output_index[0] != 0 || first_schedule.last_output_index[1] != 1) {
            throw std::runtime_error("first-cycle row schedule mismatch");
        }

        last_pos = {{10, 10}};
        infer_request cycle_two;
        cycle_two.campaign_epoch = cycle_one.campaign_epoch;
        cycle_two.msg_id = 10;
        row catch_up = hidden_row; catch_up.pos = 11; catch_up.token = 101;
        row authoritative_zero = hidden_row; authoritative_zero.pos = 12; authoritative_zero.token = 102;
        row authoritative_one = hidden_row; authoritative_one.pos = 11; authoritative_one.token = 201;
        cycle_two.sequences.push_back({0, {std::move(catch_up), std::move(authoritative_zero)}});
        cycle_two.sequences.push_back({1, {std::move(authoritative_one)}});
        const auto second_schedule = schedule_decode_rows(cycle_two.sequences, last_pos, 32);
        if (second_schedule.rows.size() != 3 ||
            second_schedule.rows[0].sequence_index != 0 || second_schedule.rows[0].row_index != 0 ||
            second_schedule.rows[1].sequence_index != 1 || second_schedule.rows[1].row_index != 0 ||
            second_schedule.rows[2].sequence_index != 0 || second_schedule.rows[2].row_index != 1 ||
            second_schedule.last_output_index[0] != 2 || second_schedule.last_output_index[1] != 1) {
            throw std::runtime_error("mixed accepted/rejected row schedule mismatch");
        }
        const auto scheduled_item = [&](int32_t output_index) -> const row & {
            const auto & scheduled = second_schedule.rows[(size_t) output_index];
            return cycle_two.sequences[scheduled.sequence_index].rows[scheduled.row_index];
        };
        const auto & proposal_zero = scheduled_item(second_schedule.last_output_index[0]);
        const auto & proposal_one = scheduled_item(second_schedule.last_output_index[1]);
        if (proposal_zero.token != 102 || proposal_one.token != 201 || proposal_zero.pos != 12 || proposal_one.pos != 11) {
            throw std::runtime_error("proposal row mapping mismatch");
        }
        cycle_two.sequences[1].rows[0].pos = 12;
        bool gap_rejected = false;
        try { (void) schedule_decode_rows(cycle_two.sequences, last_pos, 32); } catch (...) { gap_rejected = true; }
        if (!gap_rejected) throw std::runtime_error("non-contiguous mixed schedule was accepted");
        cycle_two.sequences[1].rows[0].pos = 11;

        const auto payload = encode(cycle_two);
        static constexpr size_t expected_payload_size = 8 + 8 + 1 + 2*2 + 3*(4 + 4 + HIDDEN_WIRE_BYTES);
        static constexpr size_t first_hidden_offset = 8 + 8 + 1 + 1 + 1 + 4 + 4;
        if (payload.size() != expected_payload_size || payload[first_hidden_offset] != 0x00 || payload[first_hidden_offset + 1] != 0x3c) {
            throw std::runtime_error("binary16 payload size or little-endian encoding mismatch");
        }
        const auto out = decode_infer_request(payload);
        if (out.campaign_epoch != cycle_two.campaign_epoch || out.msg_id != cycle_two.msg_id || out.sequences.size() != 2 ||
            out.sequences[0].rows.size() != 2 || out.sequences[1].rows.size() != 1 ||
            out.sequences[0].rows[1].pos != 12 || out.sequences[0].rows[1].token != 102 ||
            out.sequences[1].rows[0].pos != 11 || out.sequences[1].rows[0].token != 201) {
            throw std::runtime_error("infer round trip mismatch");
        }
        for (size_t i = 0; i < HIDDEN_WIDTH; ++i) {
            const float quantized = ggml_fp16_to_fp32(ggml_fp32_to_fp16(hidden_row.hidden[i]));
            if (out.sequences[0].rows[0].hidden[i] != quantized) throw std::runtime_error("binary16 hidden round trip mismatch");
        }
        const auto framed = encode_frame(message_type::infer_request, payload);
        if (framed.size() != payload.size() + 12 || framed[0] != 'M' || framed[1] != 'T' || framed[2] != 'P' || framed[3] != '1' ||
            framed[4] != VERSION || framed[5] != 0) {
            throw std::runtime_error("frame encoding mismatch");
        }
        std::vector<uint8_t> bad = payload;
        bad.pop_back();
        bool rejected = false;
        try { (void) decode_infer_request(bad); } catch (...) { rejected = true; }
        if (!rejected) throw std::runtime_error("truncated payload was accepted");
        bad = payload;
        bad[first_hidden_offset] = 0x00;
        bad[first_hidden_offset + 1] = 0x7c;
        rejected = false;
        try { (void) decode_infer_request(bad); } catch (...) { rejected = true; }
        if (!rejected) throw std::runtime_error("non-finite binary16 hidden value was accepted");
        std::vector<uint8_t> oversized(MAX_PAYLOAD + 1);
        rejected = false;
        try { (void) encode_frame(message_type::infer_request, oversized); } catch (...) { rejected = true; }
        if (!rejected) throw std::runtime_error("oversized frame payload was accepted");
        writer half_writer;
        rejected = false;
        try { half_writer.f16(std::numeric_limits<float>::max()); } catch (...) { rejected = true; }
        if (!rejected) throw std::runtime_error("binary16 overflow was accepted");
        infer_response response;
        response.campaign_epoch = 4; response.msg_id = 5; response.compute_us = 6; response.queue_us = 7;
        response.proposals.push_back({0, 123, 0.75f});
        const auto response2 = decode_infer_response(encode(response));
        if (response2.proposals[0].token != 123 || response2.proposals[0].probability != 0.75f) throw std::runtime_error("response round trip mismatch");
        return true;
    } catch (const std::exception & e) {
        error = e.what();
        return false;
    }
}

} // namespace remote_mtp
