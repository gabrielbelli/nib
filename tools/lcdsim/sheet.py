# Assembles lcdsim frames into images: a home-screen sheet and one strip per
# saver (every 10th frame, i.e. one per second), scaled 4x with a bezel.
import glob, os, sys
from PIL import Image, ImageDraw
d = sys.argv[1] if len(sys.argv) > 1 else 'out'
S = 4
def tile(paths, cols, label=None):
    ims = [Image.open(p).resize((160 * S, 80 * S), Image.NEAREST) for p in paths]
    pad = 12
    W = cols * (160 * S + pad) + pad
    rows = (len(ims) + cols - 1) // cols
    H = rows * (80 * S + pad + 18) + pad
    out = Image.new('RGB', (W, H), (40, 40, 44))
    dr = ImageDraw.Draw(out)
    for i, (im, p) in enumerate(zip(ims, paths)):
        x = pad + (i % cols) * (160 * S + pad); y = pad + (i // cols) * (80 * S + pad + 18)
        dr.text((x, y), os.path.basename(p)[:-4], fill=(200, 200, 200))
        out.paste(im, (x, y + 16))
    return out
tile(sorted(glob.glob(f'{d}/home_*.ppm')), 2).save(f'{d}/home.png')
for i in range(20):
    fr = sorted(glob.glob(f'{d}/saver{i}_*.ppm'))
    if not fr: break
    tile(fr[::15], 4).save(f'{d}/saver{i}.png')
    Image.open(fr[0]).save(f'{d}/_tmp.png')
    ims = [Image.open(p).resize((160 * S, 80 * S), Image.NEAREST) for p in fr]
    ims[0].save(f'{d}/saver{i}.gif', save_all=True, append_images=ims[1:], duration=100, loop=0)
print('ok')

# Thumbnails for the app's saver picker: one representative frame per saver,
# at the panel's own 160x80, written into web/savers/.
if len(sys.argv) > 2:
    dest = sys.argv[2]
    os.makedirs(dest, exist_ok=True)
    pick = {0: 12, 1: 30, 2: 60, 3: 45, 4: 12, 5: 40, 6: 60, 7: 22, 8: 55, 9: 45, 10: 30, 11: 20, 12: 75, 13: 90}
    for i, f in pick.items():
        p = f'{d}/saver{i}_{f:03d}.ppm'
        if os.path.exists(p):
            Image.open(p).save(f'{dest}/{i}.png', optimize=True)
    print('thumbs ->', dest)
