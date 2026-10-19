ITCH ?= data/synthetic.itch
DECODE_FLAGS ?=

.PHONY: all decoder trace web dev clean

all: trace web

decoder: build/mmdecode

build/mmdecode: $(wildcard decoder/src/*) decoder/CMakeLists.txt
	cmake -S decoder -B build -DCMAKE_BUILD_TYPE=Release
	cmake --build build -j

data/synthetic.itch: tools/gen_synthetic_itch.py
	mkdir -p data
	python3 tools/gen_synthetic_itch.py --out $@

trace: build/mmdecode $(ITCH)
	./build/mmdecode --input $(ITCH) --out web/public/trace.bin $(DECODE_FLAGS)

web/node_modules: web/package.json
	cd web && npm install

web: web/node_modules
	cd web && npx vite build

dev: web/node_modules
	cd web && npx vite

clean:
	rm -rf build web/dist
