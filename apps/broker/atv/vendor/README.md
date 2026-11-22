# Our pyatv build (box 0.29.7)

`pyatv-0.18.0+bargames.pr2846-py3-none-any.whl` is pyatv 0.18.0 (MIT, https://github.com/postlund/pyatv)
with the open pull request postlund/pyatv#2846, "Fix compatibility with latest AirPlay"
(head 8848ad3fd9ae46b8eb733bfc667b536a28f04c5a), merged on top.

**Why:** tvOS 26 and 27 answer stock 0.18.0's `play_url` with 403 Forbidden, so the box couldn't hand
an Apple TV a movie (pyatv reports the 403 as an AuthenticationError, which looked like "needs pairing").
Pairing, AirPlay mirroring (doubletake) and TV control (Companion) are not affected. With the PR, a
video played on an Apple TV 4K (gen 2) on tvOS 27.2.1 on 2026-11-22.

**Video only:** the PR fails 55 of pyatv's own tests that stock 0.18.0 passes (AirPlay pairing, RAOP
audio streaming, the HTTP layer), so the box keeps stock pyatv in `/opt/pyatv` for everything and runs
a second `atv-helper.py` on this build (`/opt/pyatv-video`, `../requirements-video.txt`) for the video
ops only (`video_play`, `video_control`, `video_status`). AirPlay credentials from stock pairing work there.

**What changed:** `pyatv-0.18.0-pr2846.patch` is the full diff against v0.18.0 (the only merge
conflict was `requirements/requirements.txt`; 0.18.0's pins were kept). The version is
`0.18.0+bargames.pr2846`. New dependency: biplist 1.0.3.

**Rebuild:**

```sh
git clone https://github.com/postlund/pyatv && cd pyatv
git checkout -b bargames v0.18.0
git fetch origin pull/2846/head:pr2846 && git merge pr2846   # keep 0.18.0's requirements.txt, add biplist==1.0.3
sed -i 's/^PATCH_VERSION = "0"$/PATCH_VERSION = "0+bargames.pr2846"/' pyatv/const.py
docker run --rm -v "$PWD":/src -w /src python:3.13-slim sh -c "pip install build && python -m build --wheel -o dist ."
```

**Drop it** once pyatv releases a version with the fix: move both requirements files to `pyatv==<that
version>`, delete this folder, `../requirements-video.txt` and the `pyatv-video` / `atv-vendor` lines in
`deploy/Dockerfile` (the broker falls back to the one helper when `/opt/pyatv-video` is missing).
