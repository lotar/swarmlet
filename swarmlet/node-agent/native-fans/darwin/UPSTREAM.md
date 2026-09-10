The SMC backend, formats and fan controller derive from erogol/fanctl,
commit c61f310444326bec1e4e644bbc09403a1513c487 (MIT, LICENSE.fanctl).
https://github.com/erogol/fanctl

Swarmlet changes: reject unknown data formats and invalid ranges; expose only
status, maximum and automatic control; JSON output; no socket daemon or GUI.
Status is unprivileged. Writes require OS administrator privileges. Detection
uses the firmware's fan count and min/max values, never machine model names.
