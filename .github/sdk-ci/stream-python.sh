set -eu
test ! -e /work
/cache/recording-venv/bin/python /ci/stream-python-package.py
/cache/recording-venv/bin/python /sdk/conformance/stream-python.py
