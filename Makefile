# Kotonohatlas — Atlas Linguarum Mundi
#
# Standalone package for the language-distribution map and coverage atlas UI.
# A deployment may override Atlas locales and supply host copy/publication links.
#
#   cd vendor/kotonohatlas && make build && make serve

ROOT := $(abspath .)
PORT ?= 8000

PY ?= python3
export PYTHONPATH := $(ROOT)/tools:$(PYTHONPATH)

PUBLICATION_MANIFEST ?=
OUTPUT ?= $(ROOT)/build/site
ACCESS_RUNTIME ?= $(ROOT)/dist/language-atlas-access.js

.PHONY: help test atlas-test access-runtime coverage build serve clean

help:
	@printf '%s\n' \
		'Kotonohatlas — Atlas Linguarum Mundi' \
		'' \
		'  make build                        # coverage site → build/site' \
		'  make access-runtime               # embeddable resolver → dist/' \
		'  make serve                        # http://127.0.0.1:$(PORT)/' \
		'  make test' \
		'' \
		'Optional deployment inputs:' \
		'  ATLAS_LOCALES=/path/locales.json  # Atlas UI locale override' \
		'  ATLAS_INTRO_COPY=/path/intro.json' \
		'  PUBLICATION_MANIFEST=/path/atlas-publications.json'

access-runtime:
	$(PY) $(ROOT)/tools/atlas_access.py --output "$(ACCESS_RUNTIME)"

coverage build: access-runtime
	$(PY) $(ROOT)/tools/language_coverage.py \
		$(if $(PUBLICATION_MANIFEST),--publication-manifest "$(PUBLICATION_MANIFEST)",) \
		--output "$(OUTPUT)"

serve: build
	@echo "Kotonohatlas → http://127.0.0.1:$(PORT)/"
	cd "$(OUTPUT)" && $(PY) -m http.server "$(PORT)"

clean:
	rm -rf "$(ROOT)/build"

test: atlas-test

atlas-test:
	$(PY) -m unittest discover -s $(ROOT)/tests -v
