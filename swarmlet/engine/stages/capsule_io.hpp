#pragma once
#include <filesystem>
#include <fstream>
#include <map>
#include <string>

namespace capsule_io {
namespace fs = std::filesystem;
using Owners = std::map<std::string, std::string>;
inline void write_closed(const fs::path &path, const char *data, size_t size,
                         std::ios::openmode mode = std::ios::trunc) {
    std::ofstream stream;
    stream.exceptions(std::ios::failbit | std::ios::badbit);
    stream.open(path, std::ios::binary | mode);
    stream.write(data, size);
    stream.close(); // Flush and close failures must reach the caller before acknowledgement.
}
inline void cleanup_owned(const fs::path &path, const std::string &name, Owners &owners) {
    if (!owners.count(name)) return;
    std::error_code error;
    fs::remove(path, error);
    if (!error) owners.erase(name); // Retain ownership when deletion needs a later retry.
}
using Writer = void (*)(const fs::path &, const char *, size_t, std::ios::openmode);
inline void write_pair(const fs::path &path, const char *data, size_t size,
                       const std::string &manifest, const std::string &owner,
                       Owners &owners, Writer writer = write_closed) {
    const fs::path envelope = path.string() + ".json";
    const std::string name = path.filename().string(), envelope_name = name + ".json";
    if (!owners.empty() || fs::exists(fs::symlink_status(path)) || fs::exists(fs::symlink_status(envelope)))
        throw std::runtime_error("state file exists or transfer busy");
    owners.emplace(name, owner);
    try { owners.emplace(envelope_name, owner); }
    catch (...) { owners.erase(name); throw; }
    try {
        writer(path, data, size, std::ios::trunc);
        writer(envelope, manifest.data(), manifest.size(), std::ios::trunc);
    } catch (...) {
        cleanup_owned(path, name, owners);
        cleanup_owned(envelope, envelope_name, owners);
        throw;
    }
}
}
