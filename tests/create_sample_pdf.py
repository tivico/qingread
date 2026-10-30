from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
root=Path(__file__).resolve().parents[1]/'tmp'/'pdfs'
root.mkdir(parents=True,exist_ok=True)
c=canvas.Canvas(str(root/'sample.pdf'),pagesize=(595,842))
c.setTitle('QingRead synthetic translation test')
c.setFillColor(HexColor('#204c40'));c.setFont('Helvetica-Bold',23)
c.drawString(50,780,'A Small Translation Test')
c.setFillColor(HexColor('#222222'));c.setFont('Helvetica',12)
for y,text in [(738,'This document contains a chart, a formula, and important numbers.'),(716,'Do not delete the backup. The software stores data on this computer.'),(694,'The total cost is USD 1,250.50. The experiment lasts 12 days.'),(650,'Energy equation: E = mc2'),(480,'Figure 1. Results from three experiments.'),(445,'The second experiment produced the highest result.')]:c.drawString(50,y,text)
for x,height,label in [(100,60,'A'),(220,110,'B'),(340,85,'C')]:
    c.setFillColor(HexColor('#65a28d'));c.rect(x,520,70,height,fill=1,stroke=0)
    c.setFillColor(HexColor('#222222'));c.drawString(x+30,503,label)
c.setFont('Helvetica',10);c.drawString(50,70,'Synthetic test document. No private data.');c.showPage();c.save()
print(root/'sample.pdf')
