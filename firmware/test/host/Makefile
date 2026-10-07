# Host (PC) build of the portable DSP code + tests.
CXX ?= g++
CXXFLAGS = -std=gnu++17 -O2 -Wall -Wextra -I../../include -I../../src
SRC = ../../src/dsp/fft.cpp ../../src/dsp/tremor.cpp ../../src/dsp/pronsup.cpp

all: test

build/test_dsp: test_dsp.cpp $(SRC) ../../src/dsp/*.h ../../include/*.h
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -o $@ test_dsp.cpp $(SRC)

test: build/test_dsp
	./build/test_dsp

clean:
	rm -rf build

.PHONY: all test clean
