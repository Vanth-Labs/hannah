---
name: weather
description: Get the current weather for a place (plain text, no browser)
run: curl -s "wttr.in/{arg}?format=3"
phrases: ["qué clima hace en", "que clima hace en", "qué tiempo hace en", "clima en", "tiempo en"]
---
Use this when the user asks about the weather in a place.
The input is the city or location.
Example: "qué clima hace en Buenos Aires" -> arg = Buenos Aires.
