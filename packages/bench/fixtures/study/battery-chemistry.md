# How a Lithium-Ion Cell Works, and Why It Wears Out

Lithium-ion cells power phones, laptops, power tools and electric vehicles. They store a lot of energy for their weight and can be recharged hundreds or thousands of times, but every cell slowly loses capacity. This explainer describes how a typical cell works and why it degrades, using results from a year-long test programme at the Brightwater Cell Testing Laboratory, which cycled 96 identical cylindrical cells, designated BW-21700, each rated at 3.0 ampere-hours (Ah).

## Inside the cell

A lithium-ion cell has four main parts. The negative electrode, or anode, is usually graphite: layers of carbon atoms coated onto copper foil. The positive electrode, or cathode, is a metal oxide that contains lithium; the BW-21700 uses nickel manganese cobalt oxide (NMC) coated onto aluminium foil. Between the two is a porous plastic separator about 16 micrometres thick, which keeps the electrodes from touching while letting ions pass through. Everything is soaked in an electrolyte, typically a lithium salt (lithium hexafluorophosphate) dissolved in organic carbonate solvents.

The electrolyte carries lithium ions but not electrons. That is the key to how the cell works: electrons are forced to travel through the external circuit, where they do useful work, while the ions move inside the cell.

## Charging and discharging

When the cell is charged, the charger pulls electrons out of the cathode and pushes them into the anode. To balance the charge, lithium ions leave the cathode, cross the electrolyte and slip between the graphite layers, a process called intercalation. During discharge the process reverses: the ions return to the cathode, and electrons flow through the device being powered.

A BW-21700 has a nominal voltage of 3.6 volts. It is charged to a maximum of 4.2 volts, using constant current until 4.2 volts is reached and then constant voltage while the current tapers off. It is considered empty at 2.5 volts. Charging above 4.2 volts or discharging below 2.5 volts damages the electrodes, which is why every lithium-ion pack includes a battery management system that cuts off current outside those limits.

The very first charge, done at the factory, matters a great deal. As the anode reaches a low potential for the first time, some of the electrolyte reacts with it and forms a thin layer called the solid electrolyte interphase (SEI). A stable SEI is essential, because it stops the electrolyte from breaking down further, but forming it consumes lithium permanently. In the Brightwater cells, formation used up about 8 percent of the lithium initially available.

## Why cells lose capacity

Capacity fade has several causes that act at the same time:

- **SEI growth.** The SEI keeps thickening slowly, especially at high temperature, trapping more lithium with each cycle and raising the cell's internal resistance.
- **Lithium plating.** If a cell is charged too fast, or while it is cold, lithium ions cannot slip into the graphite quickly enough and instead deposit as metallic lithium on its surface. Plated lithium is partly lost for good, and in severe cases it grows into needle-like dendrites that can pierce the separator and cause a short circuit.
- **Cathode cracking.** With every cycle the cathode particles swell and shrink slightly. Over hundreds of cycles they crack, and the fragments lose electrical contact.
- **Calendar ageing.** Cells age even when they are not used. Ageing is fastest when a cell is stored full and hot, because a high state of charge and a high temperature both speed up unwanted side reactions.

By convention, a cell has reached the end of its first life when its capacity falls to 80 percent of the rated value.

## What the Brightwater tests found

Brightwater divided its 96 cells into groups and tested each group under different conditions:

- **Baseline.** Cycled at 25°C, charged and discharged over one hour (a 1C rate), from 0 to 100 percent. These cells kept 82 percent of their capacity after 800 cycles.
- **Heat.** The same routine at 45°C. These cells fell to 80 percent capacity after only 410 cycles, roughly half the baseline life.
- **Partial cycling.** Cycled at 25°C, but using only the band between 10 and 90 percent state of charge. These cells kept 91 percent after 800 cycles, the best result in the programme.
- **Cold fast charging.** Charged at 1C at 0°C. Lithium plating was visible when the cells were opened, and they lost 12 percent of their capacity in just 50 cycles.

Storage tests showed the same pattern. Cells stored for 12 months at 100 percent charge and 40°C lost 14 percent of their capacity, while cells stored at 50 percent charge and 25°C lost only 3 percent. In the baseline group, internal resistance rose from 18 milliohms to 31 milliohms over 800 cycles, which is why an aged cell also delivers less power and warms up more under load.

The lab's practical advice follows from these figures: avoid leaving devices at full charge in hot places, avoid fast charging in freezing conditions, and where possible use the middle of the charge range rather than running the battery from full to empty.
