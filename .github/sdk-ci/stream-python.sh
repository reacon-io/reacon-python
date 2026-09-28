set -eu
test ! -e /work
/cache/recording-venv/bin/python /ci/stream-python-package.py
/cache/recording-venv/bin/python /sdk/conformance/stream-python.py
for mode in async sync; do
  REACON_HTTP_PYTHON_MODE="$mode" REACON_HTTP_RESULTS="/results/http-$mode.json" /cache/recording-venv/bin/python /ci/http-python.py
done
