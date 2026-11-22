# Astronomy 101, lecture 9: finding planets around other stars

Lecture notes. This one went long and the professor ran ten minutes over, so the last section on direct imaging is thin. (Lecture 4 covered stellar evolution; do not confuse the two sets of notes when studying for the midterm.)

## Why it is hard

A planet shines only by reflected light, and it sits very close, in angular terms, to a star that is a billion times brighter in visible light. For the Sun and Jupiter seen from 30 light-years away, the separation is about 0.17 arcseconds and the contrast is around 10^-9. Finding the planet by simply looking is like spotting a firefly next to a searchlight. So most detections are indirect: we watch what the planet does to the star.

As of the lecture date there were over 5,500 confirmed exoplanets, and the count rises every month. Most were found by the first two methods below.

## Method 1: radial velocity (the wobble)

A planet and star orbit their common center of mass. The star therefore moves in a small circle, and the Doppler effect shifts its spectral lines blue as it approaches us and red as it recedes. Measuring the shift gives the velocity.

- Jupiter makes the Sun wobble at about 12.5 m/s with a 12-year period.
- Earth makes the Sun wobble at only about 9 cm/s, which is far beyond current spectrographs (the best reach roughly 30 cm/s to 1 m/s).
- The method gives a minimum mass, m sin i, because we do not know the inclination of the orbit. A planet seen face-on produces no signal at all.
- It is biased toward massive planets in tight orbits, the "hot Jupiters".

The first confirmed planet around a Sun-like star, 51 Pegasi b, was found this way in 1995 by Michel Mayor and Didier Queloz, who shared the 2019 Nobel Prize in Physics with James Peebles. It has about half of Jupiter's mass and orbits in 4.2 days, a shock because nobody expected a gas giant that close. Earlier, in 1992, Wolszczan and Frail had found planets around a pulsar using pulse timing.

## Method 2: transits (the dimming)

If the orbit happens to be edge-on to us, the planet crosses the face of its star once per orbit and blocks a tiny fraction of the light. Transit depth is (Rp/Rs)^2, so a Jupiter-size planet blocks about 1% of the light from a Sun-like star, while an Earth-size planet blocks only about 0.0084%, or 84 parts per million.

Things the light curve tells us:

1. Period, from the time between dips.
2. Planet radius, from the depth.
3. Orbital distance, from period and Kepler's third law (a^3 = P^2 for solar-mass stars with a in AU and P in years).
4. Atmosphere composition, by comparing depth at different wavelengths (transmission spectroscopy), which is what JWST does so well.

The geometric probability of a transit is roughly Rs/a. For Earth around the Sun that is only about 0.5%, so surveys must watch a huge number of stars at once. The Kepler space telescope (launched 2009) stared at about 150,000 stars in Cygnus and Lyra for four years and found thousands of planets; TESS (launched 2018) surveys nearly the whole sky in 27-day sectors.

Combining radial velocity (mass) with transits (radius) gives density, which tells us if a planet is rocky or gassy. Many "super-Earths" and "mini-Neptunes" turned up that have no analog in our solar system, with the size gap around 1.5 to 2 Earth radii (the Fulton gap).

False positives: an eclipsing binary in the background can mimic a transit, so candidates need follow-up validation.

## Method 3: microlensing

When a foreground star passes in front of a distant background star, its gravity focuses the background light, producing a smooth brightening over days. A planet around the lens star adds a short extra spike. The event never repeats, but the method can detect cold planets far from their stars and even free-floating planets. Nancy Grace Roman Space Telescope is expected to find thousands this way.

## Method 4: direct imaging

Use a coronagraph (a small mask inside the telescope) or a starshade to block starlight. This works best for young, hot, massive planets far from their star, like the four planets around HR 8799, since young planets still glow in infrared from formation heat. Beta Pictoris b was imaged similarly.

## Method 5: astrometry

Measure the star's tiny position shift on the sky as it wobbles. Gaia is expected to find thousands of giant planets this way. It is the sky-plane partner of radial velocity.

## Habitable zone

The region where liquid water could exist on a planet's surface. For the Sun it is roughly 0.95 to 1.4 AU by conservative estimates. Dimmer red dwarfs have closer zones, so habitable-zone planets there transit often and wobble their stars more, which makes them easier targets. TRAPPIST-1 has seven Earth-size planets, three of them in the zone, 40 light-years away.

## Summary table

| Method | Measures | Best at finding |
| --- | --- | --- |
| Radial velocity | minimum mass | massive, close planets |
| Transit | radius, atmosphere | close planets, edge-on orbits |
| Microlensing | mass ratio | cold, distant planets |
| Direct imaging | brightness, spectrum | young, wide, massive planets |
| Astrometry | true mass | giants on wide orbits |

Study question: why did early surveys find mostly hot Jupiters? Selection bias: the signal from RV and transit is larger when the planet is heavy and close.

## Extra material from the problem session

The teaching assistant walked through a few numbers worth keeping. For a planet of mass m orbiting a star of mass M at distance a, the star's reflex velocity is roughly K = (m / M) x v_orbit, where the planet's orbital speed is v = sqrt(GM / a). Earth moves at about 29.8 km/s, so the Sun's wobble from Earth is 29.8 km/s times the mass ratio of 3 x 10^-6, which gives about 9 cm/s. Jupiter's mass ratio is about 1 in 1,000 and its orbital speed is 13 km/s, giving the 12.5 m/s figure from above. Spectrographs such as HARPS and ESPRESSO use a laser frequency comb or a thorium-argon lamp as a ruler for the spectral lines, which is how they reach sub-metre-per-second stability.

Stellar activity is the main enemy of small signals. Starspots rotating in and out of view create apparent velocity shifts of several metres per second, which can masquerade as planets or hide real ones. Modelling the star's magnetic cycle is now a research subfield in itself, and many "discoveries" of planets near the habitable zone of active stars have been retracted after the signal turned out to track the stellar rotation period.

The TA also reminded us how to estimate equilibrium temperature: T = T_star x sqrt(R_star / (2a)) x (1 - albedo)^(1/4). With a Sun-like star at 1 AU and Earth's albedo of 0.3, this gives about 255 K, or minus 18 degrees Celsius, and the natural greenhouse effect adds the remaining 33 degrees to bring the average to roughly 15 C.

Transit timing variations are a bonus technique: when two planets orbit near a resonance, they tug on each other and each transit arrives a few minutes early or late. That is how the masses of several planets in the Kepler-36 and TRAPPIST-1 systems were measured without any Doppler data at all.

Open question to look up before the final: what fraction of Sun-like stars have an Earth-size planet in the habitable zone (the quantity called eta-Earth)? Estimates in the literature currently range from about 5% to over 50%, depending on definitions of the zone and on how the Kepler detection efficiency is corrected.
