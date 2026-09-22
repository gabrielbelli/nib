// In-memory NVS: every run starts from defaults.
#pragma once
#include <map>
#include <string>
#include <vector>
#include <stdint.h>
class Preferences {
  std::map<std::string, std::vector<uint8_t>> m;
  template <class T> T get(const char* k, T d) { auto i = m.find(k); if (i == m.end() || i->second.size() != sizeof(T)) return d; T v; memcpy(&v, i->second.data(), sizeof v); return v; }
  template <class T> size_t put(const char* k, T v) { m[k].assign((uint8_t*)&v, (uint8_t*)&v + sizeof v); return sizeof v; }
 public:
  bool begin(const char*, bool = false) { return true; }
  void end() {}
  bool getBool(const char* k, bool d = false) { return get<bool>(k, d); }
  uint8_t getUChar(const char* k, uint8_t d = 0) { return get<uint8_t>(k, d); }
  uint16_t getUShort(const char* k, uint16_t d = 0) { return get<uint16_t>(k, d); }
  size_t putBool(const char* k, bool v) { return put(k, v); }
  size_t putUChar(const char* k, uint8_t v) { return put(k, v); }
  size_t putUShort(const char* k, uint16_t v) { return put(k, v); }
  size_t getBytesLength(const char* k) { auto i = m.find(k); return i == m.end() ? 0 : i->second.size(); }
  size_t getBytes(const char* k, void* b, size_t n) { auto i = m.find(k); if (i == m.end()) return 0; size_t c = i->second.size() < n ? i->second.size() : n; memcpy(b, i->second.data(), c); return c; }
  size_t putBytes(const char* k, const void* b, size_t n) { m[k].assign((const uint8_t*)b, (const uint8_t*)b + n); return n; }
  bool remove(const char* k) { return m.erase(k) > 0; }
  bool clear() { m.clear(); return true; }
};
