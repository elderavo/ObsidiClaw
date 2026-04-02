---
id: 202604011444
type: permanent
tags:
workspace: vaultus-sapiens
---
# OSPF

### OSPF (Open Shortest Path First)

OSPF floods **link-state advertisements (LSAs)** describing routers’ directly connected IPv4 network portions and neighbor links. Each router in the autonomous system receives these LSAs, ensuring all have the same **Link-State Database (LSDB)** representing the area’s topology. From this, every router independently computes the shortest path tree using Dijkstra’s SPF algorithm, resulting in identical routing tables.

Routers use the network portion of an IPv4 address to determine which neighbor leads toward that destination prefix. OSPF does not broadcast full routing tables but instead advertises only local connections, greatly improving efficiency. When the network changes — for example, a link goes down — new LSAs are flooded, and routers recalculate their paths quickly.

OSPF operates hierarchically with areas, reducing the size of each router’s LSDB and controlling flooding scope. Area Border Routers (ABRs) summarize routes between areas, while the backbone (area 0) connects them all, forming a scalable, convergent internal routing design.
