# Video tools

Regenerate the marketing videos (output goes to `media/`, which is git-ignored).
Needs Windows (offline text-to-speech), Google Chrome and ffmpeg.

```bash
cd tools/video
npm init -y && npm install playwright-core@1.49.1
node record-demo.js ../.. ../../media           # narrated website walkthrough (also saves screenshots)
cp -r ../../media/screenshots shots              # pitch slides use these screenshots
# add four book cover images named cov-a.jpg … cov-d.jpg for the title slide
node record-pitch.js ../../media                 # narrated pitch deck
```

Edit the narration in the `STEPS` / `LINES` arrays, and the slides in `pitch.html`.
