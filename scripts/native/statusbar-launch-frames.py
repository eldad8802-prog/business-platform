# DIAGNOSTIC ONLY (branch diag/android-statusbar-overlay) — issue 2, part 2.
# Cold-launch frames (adb screencap in a loop right after `am start`) → per frame, how far the
# status-bar band and the page area are from the settled last frame. A frame where the page is
# already the settled page (page area matches) but the status-bar band is not (band differs) is a
# frame where the page showed with the bar in a different state — the flash / temporary overlap.
# usage: python3 statusbar-launch-frames.py <frames-dir> <mode> <status-bar-bottom-px>
import sys, os, glob
from PIL import Image, ImageChops, ImageStat

d, mode, sb = sys.argv[1], sys.argv[2], int(sys.argv[3])
files = sorted(glob.glob(os.path.join(d, f"{mode}-launch-*.png")))
times = {}
tf = os.path.join(d, f"{mode}-launch-times.txt")
if os.path.exists(tf):
    for line in open(tf):
        k, v = line.split()
        times[k] = int(v)
frames = []
for f in files:
    try:
        frames.append((f, Image.open(f).convert("RGB")))
    except Exception:
        pass
if not frames:
    print(f"{mode}: no frames"); sys.exit(0)
final = frames[-1][1]
W, H = final.size
def region_diff(a, b, box):
    return sum(ImageStat.Stat(ImageChops.difference(a.crop(box), b.crop(box))).mean) / 3
out = []
flash = []
for f, im in frames:
    if im.size != final.size:
        continue
    key = os.path.basename(f).rsplit("-", 1)[1].split(".")[0]
    band = region_diff(im, final, (0, 0, W, sb))
    page = region_diff(im, final, (0, sb, W, int(H * 0.6)))
    # page shown (close to settled) but band clearly different → flash candidate
    if page < 6 and band > 12:
        flash.append(key)
    out.append(f"{key} t={times.get(key, '?')}ms band_diff={band:.1f} page_diff={page:.1f}")
print(f"== {mode} launch frames (status bar bottom {sb}px, {len(out)} frames)")
print("\n".join(out))
print(f"{mode}: flash/temporary-overlap frames: {', '.join(flash) if flash else 'none'}")
