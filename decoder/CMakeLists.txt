cmake_minimum_required(VERSION 3.16)
project(mmdecode CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O2 -g")

add_executable(mmdecode
  src/main.cpp
  src/feed.cpp
  src/counters.cpp
  src/naive_lane.cpp
  src/tuned_lane.cpp
  src/trace.cpp)
target_compile_options(mmdecode PRIVATE -Wall -Wextra)

include(CheckCXXCompilerFlag)
check_cxx_compiler_flag(-march=native HAVE_MARCH_NATIVE)
check_cxx_compiler_flag(-mcpu=native HAVE_MCPU_NATIVE)
if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64|i.86" AND HAVE_MARCH_NATIVE)
  target_compile_options(mmdecode PRIVATE -march=native)
elseif(HAVE_MCPU_NATIVE)
  target_compile_options(mmdecode PRIVATE -mcpu=native)
endif()
