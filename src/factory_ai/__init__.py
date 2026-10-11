"""factory_ai: CAD in, inspected parts out.

Modules:
    cad       procedural parts and STL loading
    synth     synthetic scans, defect injection, domain randomization
    inspect   scan-to-CAD registration, deviation maps, defect classifier, anomaly model
    maintain  spindle health from vibration
    monitor   spindle-load drift and skipped-operation detection
    spine     the data spine linking parts, machines and cycles
    timesaved inspector-time accounting with explicit assumptions
"""

__version__ = "0.1.0"
