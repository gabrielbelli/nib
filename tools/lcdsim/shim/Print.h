#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
class __FlashStringHelper;
class String {
 public:
  String(const char* s = "") : s_(s ? s : "") {}
  const char* c_str() const { return s_; }
  unsigned length() const { return (unsigned)strlen(s_); }
  char charAt(unsigned i) const { return s_[i]; }
 private:
  const char* s_;
};
class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t) = 0;
  virtual size_t write(const uint8_t* b, size_t n) { size_t k = 0; while (n--) k += write(*b++); return k; }
  size_t write(const char* s) { return s ? write((const uint8_t*)s, strlen(s)) : 0; }
  size_t print(const char* s) { return write(s); }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(int v) { char b[16]; snprintf(b, sizeof b, "%d", v); return write(b); }
  size_t print(unsigned v) { char b[16]; snprintf(b, sizeof b, "%u", v); return write(b); }
  size_t println(const char* s = "") { return write(s) + write("\n"); }
  size_t printf(const char* f, ...) __attribute__((format(printf, 2, 3))) {
    char b[256]; va_list a; va_start(a, f); vsnprintf(b, sizeof b, f, a); va_end(a); return write(b);
  }
};
