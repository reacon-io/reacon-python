set -eu
sh /suite/python-package.sh
REACON_TEST_URL="$REACON_RECORDINGS_URL/python-sync" REACON_RESULTS_FILE=/results/python-sync.json /cache/recording-venv/bin/python /suite/python.py --sync
