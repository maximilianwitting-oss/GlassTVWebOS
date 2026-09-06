# Prüft den Glas-Effekt der Kopfleiste an zwei Screenshots:
#   1. Bleibt der Verlauf in der Leiste beim Scrollen unverändert?
#   2. Geht er an der Unterkante stufenlos in den Inhalt über?
# Ohne Fremdbibliothek – PNG (Farbtyp 2, 8 Bit) selbst entpacken.
import struct, zlib

def lade_png(pfad):
    d = open(pfad, 'rb').read()
    pos, idat = 8, b''
    breite = hoehe = None
    while pos < len(d):
        laenge = struct.unpack('>I', d[pos:pos+4])[0]
        typ = d[pos+4:pos+8]
        daten = d[pos+8:pos+8+laenge]
        if typ == b'IHDR':
            breite, hoehe, tiefe, farbe = struct.unpack('>IIBB', daten[:10])
            assert tiefe == 8 and farbe == 2, 'nur 8-Bit RGB unterstützt'
        elif typ == b'IDAT':
            idat += daten
        pos += 12 + laenge
    roh = zlib.decompress(idat)

    # PNG-Zeilenfilter rückgängig machen
    kanal, schritt = 3, breite * 3
    zeilen, vorher = [], bytearray(schritt)
    p = 0
    for _ in range(hoehe):
        filt = roh[p]; p += 1
        zeile = bytearray(roh[p:p+schritt]); p += schritt
        for i in range(schritt):
            a = zeile[i-kanal] if i >= kanal else 0
            b = vorher[i]
            c = vorher[i-kanal] if i >= kanal else 0
            if filt == 1:   zeile[i] = (zeile[i] + a) & 255
            elif filt == 2: zeile[i] = (zeile[i] + b) & 255
            elif filt == 3: zeile[i] = (zeile[i] + (a + b) // 2) & 255
            elif filt == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2*c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                zeile[i] = (zeile[i] + pred) & 255
        zeilen.append(bytes(zeile)); vorher = zeile
    return breite, hoehe, zeilen

def pixel(zeilen, x, y):
    z = zeilen[y]
    return (z[x*3], z[x*3+1], z[x*3+2])

b1, h1, oben = lade_png('/tmp/kopf-oben.png')
b2, h2, unten = lade_png('/tmp/kopf-unten.png')

print('=== 1. Bleibt der Verlauf in der Kopfleiste beim Scrollen stehen? ===')
# Nur Bereiche ohne Bedienelemente messen (rechts von den Tabs, links der Knöpfe)
proben = [(1200, 20), (1200, 60), (1200, 100), (1350, 40), (900, 115)]
gleich = 0
for x, y in proben:
    a, c = pixel(oben, x, y), pixel(unten, x, y)
    d = max(abs(a[i]-c[i]) for i in range(3))
    status = 'gleich' if d <= 2 else 'ABWEICHUNG ' + str(d)
    print(f'  ({x:4d},{y:3d})  oben {a}  gescrollt {c}   -> {status}')
    if d <= 2: gleich += 1
print(f'  {gleich} von {len(proben)} Punkten unverändert')

print()
print('=== 2. Nahtstelle: geht der Verlauf stufenlos in den Inhalt über? ===')
# Direkt ober- und unterhalb der Leistenkante (endet bei y=131)
for x in (300, 960, 1600):
    ueber = pixel(oben, x, 126)
    unter = pixel(oben, x, 140)
    d = max(abs(ueber[i]-unter[i]) for i in range(3))
    # Ein sichtbarer Sprung wäre eine harte Kante; erlaubt ist die 1px-Linie
    print(f'  x={x:4d}  Leiste {ueber}  Inhalt {unter}  Unterschied {d}')

print()
print('=== 3. Verläuft die Leiste selbst? (fixed zeigt den Viewport-Ausschnitt) ===')
for x in (200, 960, 1700):
    o = pixel(oben, x, 10)
    u = pixel(oben, x, 120)
    d = max(abs(o[i]-u[i]) for i in range(3))
    print(f'  x={x:4d}  y=10 {o}  y=120 {u}  Hub {d}')
