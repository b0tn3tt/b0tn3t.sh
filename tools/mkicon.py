"""Favicons from braille art:
python3 tools/mkicon.py tools/favicon.txt web/icons  ->  favicon.svg,
favicon-32.png, apple-touch-icon.png, favicon.ico: every dot of the art
in red on a dark rounded square."""
import sys
from PIL import Image
art, outdir = sys.argv[1], sys.argv[2]
L=[l.replace("\u2800", " ") for l in open(art).read().rstrip("\n").split("\n")]
W=max(len(l) for l in L); L=[l.ljust(W) for l in L]; H=len(L)
BITS=[(0,0),(0,1),(0,2),(1,0),(1,1),(1,2),(0,3),(1,3)]
dots=set()
for y in range(H):
  for x in range(W):
    if L[y][x]!=" ":
      b=ord(L[y][x])-0x2800
      for i,(dx,dy) in enumerate(BITS):
        if b>>i&1: dots.add((2*x+dx,4*y+dy))
xs=[d[0] for d in dots]; ys=[d[1] for d in dots]
x0,x1,y0,y1=min(xs),max(xs)+1,min(ys),max(ys)+1
w,h=x1-x0,y1-y0; side=max(w,h)+8
ox=(side-w)//2-x0; oy=(side-h)//2-y0
# svg: one rect per horizontal run of dots
runs=[]
for y in range(y0,y1):
  x=x0
  while x<x1:
    if (x,y) in dots:
      s=x
      while (x,y) in dots: x+=1
      runs.append(f"M{s+ox} {y+oy}h{x-s}v1h-{x-s}z")
    else: x+=1
svg=(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}">'
     f'<rect width="{side}" height="{side}" rx="{side//6}" fill="#080000"/>'
     f'<path fill="#ff3b3b" stroke="#ff3b3b" stroke-width="1.2" stroke-linejoin="round" d="{"".join(runs)}"/></svg>\n')
open(outdir+"/favicon.svg","w").write(svg)
# png fallbacks
img=Image.new("RGBA",(side,side),(0,0,0,0))
from PIL import ImageDraw
d=ImageDraw.Draw(img); d.rounded_rectangle([0,0,side-1,side-1],radius=side//6,fill=(8,0,0,255))
for (x,y) in dots: img.putpixel((x+ox,y+oy),(255,59,59,255))
from PIL import ImageFilter
# thin one-dot lines vanish when shrunk: thicken them for the small sizes
bold=img.filter(ImageFilter.MaxFilter(3))
for n in (32,180):
  (bold if n < 64 else img).resize((n,n),Image.LANCZOS).save(outdir+f"/favicon-{n}.png" if n==32 else outdir+"/apple-touch-icon.png", optimize=True)
bold.resize((32,32),Image.LANCZOS).save(outdir+"/favicon.ico", sizes=[(16,16),(32,32)])  # for /favicon.ico requests
print(side, len(svg))
