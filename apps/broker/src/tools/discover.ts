// Field tool: list Rokus on this network and what they report.
//   npm run discover -w @bargames/broker            (SSDP)
//   npm run discover -w @bargames/broker 192.168.1.50   (one device by IP)

import { RokuEcp } from "../drivers/roku/ecp.js";
import { ssdpSearch } from "../drivers/roku/ssdp.js";

const ip = process.argv[2];
const bases = ip ? [`http://${ip}:8060`] : (await ssdpSearch("roku:ecp", 4000)).map((h) => new URL(h.location).origin);
if (!bases.length) console.log("No Rokus answered. Same subnet? Multicast allowed on this Wi-Fi?");

for (const base of bases) {
  const ecp = new RokuEcp(base);
  try {
    const info = await ecp.deviceInfo();
    console.log(`\n${info.friendlyName}  (${base})`);
    console.log(`  model:      ${info.modelName} ${info.modelNumber}${info.isTv ? "  [Roku TV]" : "  [player]"}`);
    console.log(`  software:   ${info.softwareVersion}   power: ${info.powerMode ?? "?"}   network: ${info.networkType ?? "?"}`);
    console.log(`  airplay:    ${info.supportsAirplay === undefined ? "not reported (check Settings → Apple AirPlay and HomeKit)" : info.supportsAirplay}`);
    console.log(`  dev mode:   ${info.developerEnabled}`);
    const apps = await ecp.apps().catch((e: Error) => {
      console.log(`  apps:       ${e.message}`);
      return [];
    });
    if (apps.length) console.log(`  apps:       ${apps.length} installed`);
  } catch (err) {
    console.log(`\n${base}: ${(err as Error).message}`);
  }
}
