Kun Wang (王坤) is a Postdoctoral Fellow at the Department of Computer Science, City
University of Hong Kong (CityU). He received his Ph.D. in Computer Science from CityU in
2024 under the supervision of Prof. Zhenjiang Li, and works closely with Prof. Zimu Zhou.
He received his B.E. in Software Engineering from Xidian University in 2020.

Research interests: On-Device AI Infrastructure and On-Device AI Agents, i.e. making AI
models, especially LLMs, run efficiently, reliably and privately on resource-constrained
smartphones, edge boards and IoT/wearable devices.

Research map (how the papers fit together):
- Research directions: On-Device AI Infra & Agents (long-context and local large-LLM
  inference); On-Device AI Training (heterogeneous federated learning); On-Device AI
  Sensing & Interaction (ASGaze for gaze tracking with a phone, NeuroPath for EEG
  brain-computer interfaces).
- System / runtime level (the core, "On-Device AI Infra"), organized by resource:
  - Memory: SwapNet (TMC'24) swaps DNN blocks to run models beyond the memory budget;
    ExoMem (MobiCom'26) extends this to LLMs via OS-governed memory on unified-memory
    devices. KV cache: NPUGen (MobiCom'26) uses the idle NPU to regenerate evicted KV
    on phones; ChronoCache (TMC'26) keeps a constant-memory KV state for linear-attention
    LLMs with fast/slow decay and an anchor cache.
  - Compute: NPUGen reuses idle heterogeneous accelerators; TinyML pruning (TMC'26)
    compresses and accelerates models for extremely weak IoT devices.
  - Energy: GearDVFS (MobiCom'23) jointly tunes CPU/GPU/accelerator frequencies with
    learning-based, workload-aware DVFS.
  - Training: LATTE (MobiCom'24) and its TMC'25 extension estimate on-device training
    time (aware of layer algorithms chosen by DL frameworks) and allocate sub-models in
    heterogeneous federated learning.
- Hardware level: Jetson-class edge GPUs with unified memory, smartphone SoCs
  (CPU/GPU/NPU + flash), weak IoT microcontrollers, and power/thermal domains.
- Evolution: from the DNN era (SwapNet, GearDVFS, LATTE) to the LLM era (NPUGen, ExoMem,
  ChronoCache), co-designing systems with the underlying hardware.

Honors: MobiSys Rising Star (2026), AIoTSys Rising Star (2025), CityU Postgraduate
Scholarship (2020-2024), National Scholarship of China (2018, 2019).
Invited talks: AIoTSys Rising Star Forum (2025.08), CCF-Talk (2025.05), Flower Monthly
by Flower Labs (2025.04), Xidian University Seminar (2024.10).
Services: TPC member of IEEE MASS 2026 and ACM MobiCom Demos 2025; reviewer for MobiCom,
SenSys, MobiSys, IPSN, IWQoS, IoTDI, INFOCOM, ICDCS, IEEE TMC, TC, TCCN, TCE, ACM TOCS.
Teaching: TA for CS2310 Computer Programming (2022-2024) and CS2204 (2023) at CityU.
Contact: kwang69-c@my.cityu.edu.hk. Google Scholar: https://scholar.google.com/citations?user=-cCYLZ8AAAAJ