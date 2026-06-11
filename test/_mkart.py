
import os, sys
art = sys.argv[1]; os.makedirs(art, exist_ok=True)
known_pdf = ["CLAWD TEST DOCUMENT","",
"This document concerns the migration of legacy systems to AWS.",
"The secret project codename is BLUEHERON.",
"Budget approved: 250000 SGD for fiscal year 2026.",
"Lead engineer: Bryan. Deadline: 30 September 2026.",
"Key risk: exFAT drive symlink incompatibility on Windows build hosts."]
known_txt = ("CLAWD PLAINTEXT FIXTURE\n"
"The distinctive phrase is: PURPLE PANGOLIN PROTOCOL.\n"
"This file tests text/plain extraction end to end.\n")
open(os.path.join(art,"clawd_fixture.txt"),"w",encoding="utf-8").write(known_txt)
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
c = canvas.Canvas(os.path.join(art,"clawd_doc.pdf"), pagesize=A4)
y=800
for line in known_pdf:
    c.drawString(60,y,line); y-=24
c.showPage(); c.save()
from PIL import Image, ImageDraw, ImageFont
img=Image.new("RGB",(720,280),(255,255,255)); d=ImageDraw.Draw(img)
try: font=ImageFont.truetype("arial.ttf",36)
except Exception: font=ImageFont.load_default()
d.text((30,40),"CLAWD VISION TEST",fill=(0,0,0),font=font)
d.text((30,110),"Total: $42.50 SGD",fill=(0,0,0),font=font)
d.text((30,180),"Codeword: SCARLET IBIS",fill=(0,0,0),font=font)
img.save(os.path.join(art,"img_text.png"))
Image.new("RGB",(48,48),(250,250,250)).save(os.path.join(art,"img_blank.png"))
for f in sorted(os.listdir(art)):
    print(f, os.path.getsize(os.path.join(art,f)),"bytes")
