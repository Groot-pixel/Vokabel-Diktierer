# Vokabel-Diktierer

Web-App zum Abschreiben/Üben von Englisch-Vokabeln: Seite aus dem Vokabelbuch fotografieren → Vokabeln prüfen → die App diktiert.

Ausgelegt auf das Buchlayout **Englisch [Lautschrift] | Deutsch | Merksatz** inkl. der umrahmten Kästen mit zwei Wortpaaren nebeneinander (z. B. „Respect“, „Jobs“).

## Benutzen

1. **Seite scannen** – Foto machen oder Bild(er) hochladen. Mehrere Seiten werden an die aktuelle Liste angehängt.
2. **Vokabeln prüfen** – erkannte Einträge korrigieren, löschen, ergänzen. Nur angehakte Vokabeln werden diktiert.
3. **Diktat** – Modus wählen:
   - Englisch + Deutsch schreiben
   - Englisch + Deutsch + Merksatz schreiben
   - Englisch + Deutsch schreiben, Merksatz nur anhören
   - Nur Englisch schreiben (Deutsch als Hilfe anhören)
   - Abfrage: Deutsch hören → Englisch schreiben
   - Eigene Einstellung: pro Feld *schreiben / nur anhören / aus*

   Unter „Tempo & Extras“: Sprechtempo, Schreibpause, Wiederholungen, Buchstabieren, Zufallsreihenfolge, Stimmenauswahl.
   Danach unter „Kontrolle“ die Lösungen anzeigen.

## Texterkennung – ehrliche Einschätzung

| Methode | Kosten | Qualität |
|---|---|---|
| **Tesseract** (Standard, läuft im Browser) | kostenlos | Bei schrägen/gewölbten Handyfotos nur teilweise brauchbar: Wörter meist richtig, aber Merksätze rutschen oft in die falsche Zeile, Kästen werden schlecht getrennt. Nachkorrektur nötig. |
| **Claude-KI** | eigener API-Schlüssel (console.anthropic.com), wenige Cent pro Seite | Versteht das Layout, erkennt auch blau gedruckte (optionale) Wörter und hakt sie ab. |

Tipps für bessere Fotos: Seite flach drücken, gerade von oben, hell, ohne Schatten, nur eine Seite pro Foto.

## Starten

Statische Seite ohne Build – `index.html` über einen Webserver öffnen, z. B. GitHub Pages
(Repo → Settings → Pages → Branch wählen). Für die Kamera am Handy ist HTTPS nötig, was GitHub Pages liefert.

Vorlesen nutzt die Sprachausgabe des Geräts (Chrome, Edge, Safari). Listen und Einstellungen bleiben nur in diesem Browser gespeichert.
