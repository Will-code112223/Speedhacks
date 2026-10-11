# Architecture and roadmap

## Who it is for

**Buyer:** the quality manager at a 50 to 500 person CNC job shop that makes aerospace, medical or semiconductor-equipment parts. These shops run many part numbers in short batches and already have CAD for every part. Inspection is mandatory, slow and manual.

**Why existing AI inspection doesn't fit:** most tools need dozens to thousands of real images of each defect type. Bespoke parts never produce them. Starting from CAD removes that requirement.

## Three modules, one edge box

| Module | Replaces | Input | Method in this repo | Output |
| --- | --- | --- | --- | --- |
| Inspect | Manual visual and gauge checks | CAD + a 3D scan | ICP to CAD, signed deviation, region classifier trained on synthetic defects, good-parts anomaly model | PASS / REVIEW / FAIL with a heat map |
| Maintain | Fixed-interval service | Spindle accelerometer | Envelope analysis at the bearing fault frequency, per-machine baseline | Health score, sustained-deviation alert |
| Monitor | Spot checks of the process | Spindle load per cycle | Per-part-number signature, EWMA control chart, missing-operation check | Drift alert, flagged cycle and operation |

All three write to the **data spine**: every record is keyed by part serial, machine and cycle. That link answers questions none of the modules can answer alone. For example: the burrs began after Monitor saw spindle load rising on M-07, so change the tool.

## Production layout (target)

- **In the plant:** an edge box (Jetson-class GPU) runs every model offline and buffers data if the network drops. Cameras or a scanner sit at the inspection station, and machine data arrives over OPC UA or MTConnect.
- **In the cloud:**
  - CAD ingest (STEP to mesh)
  - a data engine that renders scenes and injects defects
  - training and a model registry
  - the data spine
  - a web app for CAD upload, the review queue and reports
- **Data flow:** only flagged images and metadata leave the site by default. Signed model updates flow back down.

## Roadmap

1. **Now (this repo):** geometric inspection from simulated 3D scans; Maintain and Monitor on simulated signals; the data spine; a demo report.
2. **Next:**
   - scan five real BRK-style parts and measure the sim-to-real gap
   - STEP ingest via OpenCascade
   - export models to ONNX for the edge box
   - a web review queue
3. **Then:**
   - photorealistic renders (BlenderProc or Isaac Sim) plus PatchCore-style image anomaly detection (Anomalib) for cosmetic defects
   - OPC UA and MTConnect adapters
   - clamp-on sensor kits for older machines
4. **Later:**
   - root-cause suggestions across machines
   - self-serve onboarding for new part numbers
   - CAD-based pose estimation for robot handling

## Known limitations

- **Reflective metal:** glare and tool marks on real machined aluminum will create false regions the simulator does not model. Plan: a measured material library, polarized lighting, and the calibration step.
- **Small burrs:** burrs under about 2 mm across sit near the scan-density limit. That is the one miss in the demo shift. A denser scan or a second view of the hole rims helps.
- **Warp:** warp is a whole-part defect, and the demo detects it as large regions. A dedicated flatness check, as in GD&T, would be cleaner.
- **Monitor's alert threshold:** it is set from 30 baseline cycles. Real shops need one baseline per part number and per tool.
