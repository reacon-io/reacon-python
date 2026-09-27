set -eu
sh /suite/python-package.sh
REACON_TEST_URL="$REACON_RECORDINGS_URL/python-sync" REACON_RESULTS_FILE=/results/python-sync.json /cache/recording-venv/bin/python /suite/python.py --sync
REACON_TEST_URL="$REACON_STREAM_TEST_URL" /cache/recording-venv/bin/python /sdk/conformance/stream-python.py
