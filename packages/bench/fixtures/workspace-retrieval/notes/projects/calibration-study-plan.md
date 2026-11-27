# Snow-depth sensor temperature drift study

Owner: Hana T, with help from Luis R. Goal: quantify how much the ultrasonic snow-depth sensor in the Colorado fleet drifts between -25 C and +5 C, and decide whether firmware compensation is enough or the hardware needs a thermistor change.

## Method
- Twelve sensors in the environmental chamber at the Missoula-side warehouse, held for 4 hours at each of seven temperature steps
- Reference target at a fixed 1.50 m
- Log raw time-of-flight and the on-board temperature reading each minute

## Acceptance
Error under 10 mm across the range after compensation. Without compensation the bench result from last winter was a 38 mm error at -25 C.

## Schedule
Chamber booked June 15 to June 26. Analysis by July 10. Result goes into the firmware 4.3 scope review.

## Open items
The chamber door seal leaks at the coldest step; Luis is taping a baffle. Sensors 7 and 11 have an older transducer lot and are tracked separately.
