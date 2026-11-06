"""Favicons from the braille cat (tools/cat.txt, also fetch's logo):
python3 tools/mkicon.py tools web/icons  ->  favicon.svg, favicon-32.png,
apple-touch-icon.png, favicon.ico: the cat's dots in red on a dark rounded square."""
import sys
from PIL import Image
S, outdir = sys.argv[1], sys.argv[2]
L=[l.replace("⠀"," ") for l in open(S+"/cat.txt").read().rstrip("\n").split("\n")]
W=max(len(l) for l in L); L=[l.ljust(W) for l in L]; H=len(L)
# the cat's cells only (largest 4-connected group), as in fetch
comp=[[None]*W for _ in range(H)]; sizes=[]
for y in range(H):
  for x in range(W):
    if L[y][x]!=" " and comp[y][x] is None:
      k=len(sizes); st=[(y,x)]; comp[y][x]=k; n=0
      while st:
        cy,cx=st.pop(); n+=1
        for dy,dx in ((0,1),(0,-1),(1,0),(-1,0)):
          ny,nx=cy+dy,cx+dx
          if 0<=ny<H and 0<=nx<W and L[ny][nx]!=" " and comp[ny][nx] is None:
            comp[ny][nx]=k; st.append((ny,nx))
      sizes.append(n)
big=sizes.index(max(sizes))
BITS=[(0,0),(0,1),(0,2),(1,0),(1,1),(1,2),(0,3),(1,3)]
dots=set()
for y in range(H):
  for x in range(W):
    if comp[y][x]==big:
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
     f'<path fill="#ff3b3b" d="{"".join(runs)}"/></svg>\n')
open(outdir+"/favicon.svg","w").write(svg)
# png fallbacks
img=Image.new("RGBA",(side,side),(0,0,0,0))
from PIL import ImageDraw
d=ImageDraw.Draw(img); d.rounded_rectangle([0,0,side-1,side-1],radius=side//6,fill=(8,0,0,255))
for (x,y) in dots: img.putpixel((x+ox,y+oy),(255,59,59,255))
for n in (32,180):
  img.resize((n,n),Image.LANCZOS).save(outdir+f"/favicon-{n}.png" if n==32 else outdir+"/apple-touch-icon.png", optimize=True)
img.resize((32,32),Image.LANCZOS).save(outdir+"/favicon.ico", sizes=[(16,16),(32,32)])  # for /favicon.ico requests
print(side, len(svg))
