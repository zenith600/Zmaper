# Zmaper — free, open-source projection mapping software for Windows

**Zmaper is a free and open-source projection mapping application for Windows, and
an alternative to MadMapper, Resolume Arena and HeavyM.** Warp video, images and
live camera onto real-world surfaces, mask them to the geometry of the object, and
soft-blend overlapping projectors. MIT licensed — no trial, watermark or feature gate.

**[Download](https://github.com/zenith600/Zmaper/releases/latest)** ·
**[Website](https://zenith600.github.io/Zmaper/)**

Electron shell, WebGL2 rendering, borderless fullscreen output on the display of
your choice.

### At a glance

| | |
| --- | --- |
| **Price** | Free, MIT licence |
| **Platform** | Windows 10/11, 64-bit |
| **Warping** | Quad (projective homography) and mesh (Catmull-Rom patches) |
| **Masking** | Feathered polygon masks, stored in surface space |
| **Multi-projector** | Per-edge soft edge blending with adjustable blend gamma |
| **Sources** | Video (H.264/WebM/MOV/OGV), images, live webcam, calibration patterns |
| **Remote control** | Phone UI over the LAN, paired by QR code |
| **Not included** | Spout/NDI/Syphon, DMX/Art-Net, audio reactivity, HEVC playback |

## Running it

```powershell
npm install
npm start
```

`npm run dev` additionally opens DevTools.

## Building the Windows executable

```powershell
npm run dist            # installer + portable, into dist\
npm run dist:portable   # portable exe only
npm run pack            # unpacked folder only, no installer
```

Produces in `dist\`:

| File | |
| --- | --- |
| `Zmaper-Setup-1.0.0.exe` | Installer. Lets you choose the install directory, creates Start Menu and desktop shortcuts, installs per-user so it needs no admin rights. |
| `Zmaper-1.0.0-portable.exe` | Single-file portable build. Run it from anywhere, including a USB stick — nothing is installed. |
| `win-unpacked\Zmaper.exe` | The unpacked app, for testing a build without installing. |

The build is **unsigned**, so the first launch shows a SmartScreen warning —
*More info* then *Run anyway*. Signing it requires a code-signing certificate;
point `CSC_LINK` and `CSC_KEY_PASSWORD` at a `.pfx` and electron-builder will
sign automatically.

### If the build fails on `winCodeSign`

electron-builder downloads a signing bundle that contains macOS symlinks, which
Windows refuses to create without Developer Mode, and the extraction aborts. The
Windows build does not need those two files. Extract the bundle yourself once:

```powershell
$cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
Get-ChildItem $cache | Where-Object { $_.Name -match '^\d+(\.7z)?$' } | Remove-Item -Recurse -Force
& node_modules\7zip-bin\win\x64\7za.exe x "$cache\<downloaded>.7z" "-o$cache\winCodeSign-2.6.0" -y
```

It reports two symlink errors and exits non-zero; that is expected. Everything the
Windows build needs (`signtool.exe`, `rcedit`) is extracted, and electron-builder
reuses the folder from then on. Enabling Windows Developer Mode fixes it
permanently.

## The two windows

**Editor** — where you build the show. The centre canvas is a live preview of the
output at full output resolution, with wireframes and handles drawn on top.

**Output** — what the projector sees. Borderless, fullscreen on one display, no
chrome, no handles. Pick the display in the toolbar dropdown and press
**Start Output**. Press **Esc** on the output window to close it at any time.

The output window keeps its own copy of the media and renders independently, so
editor UI work never costs you output frames, and a stalled editor can never
freeze the projector. See *Video playback* below.

## Surfaces

**Quad** — four corners, full keystone. The warp is a true projective homography
computed per frame, so the texture stays perspective-correct no matter how hard you
keystone it. This is what you want for flat panels, screens, walls and billboards.

**Mesh** — an *n* x *m* grid of control points. In **Smooth** mode the surface is a
Catmull-Rom patch, which is what makes curved walls, columns, cylinders and domes
land correctly. **Linear** mode keeps cell edges straight. Change the grid density
in the inspector at any time — the existing shape is resampled onto the new grid
rather than reset.

Switching a surface between Quad and Mesh preserves its shape.

## Canvas controls

| Action | Input |
| --- | --- |
| Move a surface | Drag inside it |
| Warp | Drag a handle |
| Multi-select handles | Shift+click, or Shift+drag a box |
| Constrain to one axis | Hold Shift while dragging |
| Nudge | Arrow keys (Shift = 10px, Alt = sub-pixel) |
| Zoom | Scroll wheel |
| Pan | Space+drag, or middle-drag |
| Fit view | `F` |

## Tools

| Key | Tool | |
| --- | --- | --- |
| `V` | Warp | Move and warp surfaces |
| `K` | Mask | Click to add mask points, drag to move, right-click to delete |
| `I` | Source | Drag the crop rectangle directly on the media |

Mask points are stored in the surface's own parametric space, so a mask stays
locked to the surface as you keep warping it. For meshes the editor inverts the
Catmull-Rom patch numerically to turn a click into a surface coordinate.

## Edge blending

Each surface has an independent feather width on its left, right, top and bottom
edges plus a blend gamma. Feather the overlapping edge on *both* projectors'
surfaces and raise the gamma until the overlap stops reading as a bright or dark
band — a straight linear ramp will not sum flat on a real projector, which is what
the gamma term corrects for.

## Media

- **Video** — mp4, webm, mov, m4v, ogv. Loop, rate, volume per item.
- **Images** — png, jpg, gif, webp, bmp.
- **Webcam** — live capture (`+ Cam`). The webcam's row in the **MEDIA** list
  *is* a dropdown: open it to switch cameras. The same picker appears under
  **Source → Camera** in the inspector when a webcam feeds the selected
  surface, with a **Rescan** button for anything plugged in since launch.
  Switching restarts the capture in the editor and on the projector together.
  Camera names only appear once you allow camera access — before that the list
  reads "Camera 1 / Camera 2".
- **Patterns** — grid, checker, colour bars, circles, crosshair, gradient,
  linearity. These are the calibration targets you actually align a projector
  with; the grid is labelled TL/TR/BL/BR so orientation and flips are unambiguous.
- **Solid colour**.

Add files with **`+ File`** next to the MEDIA header, **`+ Media`** in the
toolbar, or by dragging them in from Explorer. Click a media item to assign it to
the selected surface. Per surface you also get crop, rotate, flip, opacity, blend
mode (normal / add / screen / multiply), tint, brightness, contrast, saturation
and gamma.

### Drag and drop

Where you drop a file decides what happens:

| Drop target | Result |
| --- | --- |
| **On a surface in the canvas** | Adds the file and assigns it to that surface, replacing what it was showing. The surface is selected too. |
| **On a row in the MEDIA list** | Replaces that media item's source *in place*. The item keeps its identity, so every surface already using it switches over at once — in the editor and on the projector. |
| **On empty MEDIA list space** | Adds to the library and assigns to the currently selected surface. |
| **On a row in the SURFACES list** | Adds and assigns to that surface. |
| **Anywhere else** | Adds to the library. |

Dropping several files at once adds them all and assigns the first. Dropping a
folder adds the media files directly inside it. Unsupported files are ignored.

## Mobile remote

Mapping is a two-person job otherwise: someone at the laptop, someone at the
wall. **Remote** in the toolbar serves a touch UI on your network so you can
warp surfaces while standing in front of the projection.

1. Click **Remote**, pick a port (default 7777), press **Start server**.
2. Scan the QR code with a phone on the same Wi-Fi, or tap the link to copy it.

From the phone you get the surface geometry live, with touch-sized handles:
drag a handle to warp, drag inside a surface to move it, and tap a surface to
select it. The tabs give you:

| Tab | |
| --- | --- |
| **Surfaces** | Select, show/hide, solo, add quads and meshes, transport, start/stop the projector output |
| **Media** | Tap to assign a source to the selected surface |
| **Tune** | Opacity, brightness, master level, and the four edge-blend feathers with blend gamma |
| **Nudge** | A D-pad at 0.25 / 1 / 5 output pixels, for the selected handle or the whole surface |

**Preview** streams a low-rate JPEG of the output to the phone so you can see
the composition without looking back at the laptop. It is off by default
because it costs bandwidth.

The desktop app always stays the source of truth — the phone holds no
authoritative state, so a phone dropping off Wi-Fi can never corrupt a show.
The connection reconnects by itself when the screen sleeps or you roam.

### Access and safety

The link carries a random key, and `/events` and `/cmd` reject anything
without it. **Anyone on the network who has the link can control the
projection** — treat it like a password. **New access key** reissues it and
disconnects every phone; stopping the server closes the port entirely. The key
changes every time the server starts, so old links go dead on their own.

Static assets are served without the key (they contain nothing sensitive, and
ES module imports cannot carry a query string); only the control channel is
gated.

If the phone will not connect, the panel lists every network adapter. The app
picks the address the OS actually routes from, which avoids handing you a
VirtualBox or Hyper-V address no phone can reach — but if your machine is on
several real networks, pick the right one there and the QR code updates.

## Shortcuts

| | |
| --- | --- |
| `Q` / `M` | Add quad / mesh |
| `Ctrl+D` | Duplicate surface |
| `Delete` | Delete surface |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+A` | Select all handles |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save As |
| `Ctrl+O` / `Ctrl+N` | Open / New |

## Projects

Saved as `.zmap` — plain JSON holding the output config, media list and every
surface. Media is referenced by absolute path; on open, missing files are reported
by name rather than failing silently.

## Layout

```
src/
  main/
    main.js          Electron main: windows, displays, IPC, file dialogs
    preload.js       contextBridge API surface
    remote.js        LAN server for the phone remote (SSE out, POST in) + QR
  renderer/
    core/
      math.js        Homography (Heckbert), Catmull-Rom patches, hit-test helpers
      state.js       Project model, defaults, migration, serialisation
      media.js       Video/image/webcam/pattern sources, GL upload, stall watchdog
      renderer.js    WebGL2 pipeline: warp, colour, mask, edge blend, blend modes
      surfaceGeom.js Parametric <-> output mapping, incl. numeric mesh inverse
    editor/
      index.html  editor.css  editor.js  inspector.js  remote.js
    output/
      output.html  output.js
    mobile/
      index.html  mobile.css  mobile.js     (served to phones)
```

The phone UI imports `core/math.js` and `core/surfaceGeom.js` directly over
HTTP, so the warp maths on the phone is literally the same code the projector
renders with — a mesh dragged on a phone cannot disagree with the output.

## Video playback

Three things here look like over-engineering and are not. All of them exist
because on a single-display machine the fullscreen output window completely
covers the editor, and Chromium suspends an occluded window's media pipeline.

**The output never follows the editor's clock.** An earlier design had the
editor broadcast its video position once a second and the output correct
itself to match. When the editor was occluded its clip reached the end, failed
to complete the loop's seek back to zero, and wedged — and the output, dutifully
obeying a frozen clock, froze with it. The projector must never depend on the
editor window's health, so that sync is gone. Transport commands align them.

**Looping is driven explicitly.** Letting a clip reach its final frame is what
wedges the pipeline, so playback wraps about four frames early instead. The
skipped frames are not perceivable; the stall they avoid very much is.

**A watchdog catches the rest.** Any video whose clock stops while it still
claims to be playing gets restarted — fast when it is sitting on the last
frame of a loop, after a longer grace period otherwise, since a mid-clip stall
is more likely a decode hiccup that resolves itself. Without it, a wedged clip
stays frozen indefinitely rather than for a fraction of a second.

It also retries playback that was *refused* rather than stalled. The output
window opens hidden, and a media element created before it is shown can have
its autoplay rejected, leaving it paused with nothing to start it. The pool
tracks whether each clip is meant to be running, so a refusal is retried while
a deliberate Pause is left alone.

If a clip still cannot be played on the projector, its row in the MEDIA list
turns red with the reason on hover, and a message names the file — rather than
leaving a silently black surface.

The app also launches with Chromium's occluded-window backgrounding disabled,
which keeps the covered editor's preview rendering.

**Video decodes in software, on purpose.** The editor and the output each
decode the clip independently. Intel's hardware decoder has only a handful of
sessions, and re-initialising one while another is live — exactly what a loop
wrap does — took about three seconds, freezing the projector at every loop.
With a single window there was no stall at all, which is what identified the
contention. Software decode has no session limit and loops cleanly; it costs
roughly 13% of total CPU for two simultaneous 1080p30 decodes on a 12-thread
machine. Drop `disable-accelerated-video-decode` from `src/main/main.js` if you
are on hardware with plenty of decode sessions and would rather spend GPU than
CPU.

## Performance

The editor renders its preview at `zoom × dpr` of the output resolution rather
than full size — at the default fit-zoom that is about a quarter of the pixels,
and it means a 4K project costs the editor no more than a 1080p one. Zoom in
and the preview sharpens back up to full resolution.

Video frames go to the GPU with `texSubImage2D` once the texture exists, so the
texture store is written in place instead of being reallocated every frame.

Both windows draw on every vsync. Throttling the editor to 30fps to "give the
output room" was measured and was *worse* — the two loops beat against each
other and the output dropped 60 frames in 14 seconds, versus none when both run
freely. Keeping the editor's frame cheap is what buys the headroom, not
starving it.

On the Intel UHD machine this was tuned on, with a 1080p clip on both windows:
60fps locked, 95th-percentile frame time ~21ms, and no dropped frames across
repeated loop boundaries.

## How the warp works

Quads tessellate the unit square 32x32 and push every vertex through the
homography in the vertex shader; UVs come from the parametric coordinate, so
perspective correction is exact at vertices and negligible in between. Meshes bake
their warped positions on the CPU from the control grid at 12 subdivisions per
cell.

The fragment shader samples the source, applies gamma, contrast, saturation and
tint, then multiplies alpha by the edge-blend ramp and the mask texture. Output is
premultiplied, which lets every blend mode be a single `blendFunc`.

Masks are rasterised to a 512x512 texture on a 2D canvas (polygon fill plus a blur
for the feather) and cached until the mask changes.

## Known limits

- One projector output window at a time. Multi-projector today means one machine
  per projector, or one wide output spanning both via the GPU's display spanning.
- No Syphon/Spout/NDI input, no DMX, no audio reactivity, no custom GLSL slot.
- Editor and output decode video independently, and the output owns its
  playback outright — it does not follow the editor's clock. Play, Pause and
  Restart align both windows; between those they can drift by a fraction of a
  second. That is deliberate: see *Video playback* below.
- Looping clips still hitch for under a second at the wrap point perhaps a
  quarter of the time, when Chromium's seek is slow under load. Content that
  does not loop is unaffected.
