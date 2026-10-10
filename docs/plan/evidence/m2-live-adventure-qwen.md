# M2 live evidence: Adventure #1 solo turns on local qwen

Run started 2026-10-10T04:16:52.302Z. Endpoint: `http://172.31.25.75:8080/v1` (local stand-in; not the hosted reference endpoint). Model: `qwen3.8-35b-a3b-distill-q4`. Tool mode: native (per the probe record in `docs/plan/m2-proof-report.md`).

Adventure `adventure:01-hollow-under-marrowfell`, start scene `scene-marowfell-well`. Character: `class:cleric` level 1 (quickBuild, seed 0x28), actor id scrubbed to a random UUID. Runner: `ProductionSoloTurnRunner` with a real `OpenAICompatibleAdapter` (stream timeout 180000 ms; production default is 12000 ms). maxTokens: production values (512 first request, 400 after tool results, set in `orchestrator.ts`).

Model calls this run: 34 (budget 60). Credential supplied via env only; not recorded. Scratch database and fixture directory were discarded.

## Summary

| # | Player input (id) | DM calls | Summary calls | Tool calls requested | Rejected | Rolls | close_scene | Scene before -> after | Fallback | Out tokens | Wall ms | Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | I look around the well. What do I see here? (look) | 1 | 0 | 0 | 0 | 0 | no | scene-marowfell-well -> scene-marowfell-well | - | 482 | 8282 | - |
| 2 | I walk up to the hooded figure beside the well and ask what happened to the village. (talk) | 1 | 0 | 0 | 0 | 0 | no | scene-marowfell-well -> scene-marowfell-well | - | 507 | 7207 | - |
| 3 | I search the stonework for a hidden inscription. Please call for a Perception check. (check) | 4 | 2 | 3 (request_check, close_scene, close_scene) | 0 | 0 | yes -> scene-marowfell-well next=scene-broken-gatehouse; scene-marowfell-well next=scene-broken-gatehouse | scene-marowfell-well -> scene-broken-gatehouse | - | 1538 | 30419 | - |
| 4 | I lower myself down into the well shaft and listen for anything below. (descend) | 2 | 0 | 1 (request_check) | 0 | 0 | no | scene-broken-gatehouse -> scene-broken-gatehouse | - | 507 | 5874 | - |
| 5 | We are done here. Let's move on to the next place. (close-1) | 9 | 8 | 9 (close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene, close_scene) | 1 | 0 | yes -> scene-broken-gatehouse next=scene-chapel-of-wicks; scene-broken-gatehouse next=scene-chapel-of-wicks; scene-broken-gatehouse next=scene-chapel-of-wicks; scene-broken-gatehouse next=scene-chapel-of-wicks; scene-broken-gatehouse next=scene-chapel-of-wicks; scene-broken-gatehouse next=scene-chapel-of-wicks; scene-broken-gatehouse next=scene-chapel-of-wicks; scene-broken-gatehouse next=scene-chapel-of-wicks | scene-broken-gatehouse -> scene-chapel-of-wicks | budget-exhausted | 3956 | 112695 | - |
| 6 | I look around the broken gatehouse. Who or what is here? (gatehouse) | 1 | 0 | 0 | 0 | 0 | no | scene-chapel-of-wicks -> scene-chapel-of-wicks | - | 330 | 4495 | - |
| 7 | I ask the gatekeeper's ghost about the bell in the chapel. (ghost) | 1 | 0 | 0 | 0 | 0 | no | scene-chapel-of-wicks -> scene-chapel-of-wicks | - | 512 | 6105 | - |
| 8 | We are done here, move on. (close-2) | 3 | 2 | 2 (close_scene, close_scene) | 0 | 0 | yes -> scene-chapel-of-wicks next=scene-warren-gallery; scene-chapel-of-wicks next=scene-warren-gallery | scene-chapel-of-wicks -> scene-warren-gallery | - | 993 | 20003 | - |

## Turns

### Turn 1: look

Player: I look around the well. What do I see here?

Narration (as delivered by the orchestrator):

> The well-head rises from the earth like a stone throat, its rim choked with the husks of lanterns—tallow cups gone cold, their glass cracked black with soot. The air tastes of old smoke and something sour, like milk left in a cellar too long.
> 
> Nessa Kell stands at the edge, her cloak damp from the mist that clings to Gallows Knoll's slopes. She's been here since before dawn, waiting for you. "The water's gone bitter," she says quietly, not looking at you. "Three days now. Tastes of copper and rot. The old story says the Ember Lamp keeps the hold warm—keeps the dark out. But the lamps are dead, and the dark's been creeping up for a week."
> 
> She gestures toward the well's mouth, a ragged circle of shadow in the stone. Cold air exhales from it, carrying the faintest smell of tallow and wet stone.
> 
> "The gatehouse above is fallen," she adds. "But the way down is still there. You can see it, if you look past the rubble."
> 
> The well's darkness waits. What do you do?

Fallback: none. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 8551/482.

- call dm: maxTokens=512, in=8551, out=482, ttft=5112 ms, latency=8236 ms, visible text chars=971
- events: TurnStartedx1, TurnCommittedx1

### Turn 2: talk

Player: I walk up to the hooded figure beside the well and ask what happened to the village.

Narration (as delivered by the orchestrator):

> Nessa Kell regards you as you approach, her hooded face unreadable in the grey light. She shifts her cloak tighter, as if the bitter air has seeped into her bones.
> 
> "The village?" she says, voice low. "Marrowfell was a holding of the Tallow Hold—two dozen souls, a few cattle, the old Ember Lamp kept in the kennel beneath the gatehouse. We survived on the lamp's warmth and the well's water. For years."
> 
> She gestures toward the ragged circle of stone, the dead lamps around its rim. "Three nights ago, the lamp guttered and died. The well went sour. We drank from it anyway—what else was there?—and by morning the cattle were dead and the children coughing up black phlegm. By evening, the well was bitter enough that nothing living would touch it."
> 
> She meets your eyes now, the hood shadowing her gaze. "The gatehouse is fallen. The way down is still there, past the rubble. The Ember Lamps don't just keep the dark out—they keep something else out. And it's been creeping up since the light went out."
> 
> A cold breath rises from the well's mouth, carrying the faintest whisper of tallow and wet stone. "You'll go down, won't you? I can't. I've been here since before dawn, waiting for someone brave enough or foolish enough."
> 
> She steps back, giving you the path past the rubble toward the broken gatehouse. "The way down is beneath it. The old Tallow Hold. If the lamp is still there, the hold is still warm. If it's gone..." She doesn't finish.
> 
> The cold air from the well exhales again, heavier now, as if something below is breathing.
> 
> What do you do?

Fallback: none. Scene: scene-marowfell-well -> scene-marowfell-well. Turn usage in/out: 9586/507.

- call dm: maxTokens=512, in=9586, out=507, ttft=2191 ms, latency=7175 ms, visible text chars=1559
- events: TurnStartedx1, TurnCommittedx1

### Turn 3: check

Player: I search the stonework for a hidden inscription. Please call for a Perception check.

Narration (as delivered by the orchestrator):

> You step past the dead lamps and approach the leaning gatehouse. Rubble spills across the flagged yard, and cold air smells of tallow and wet stone. The ember-glow pulses faintly in the kennel beneath the broken arch, then dims.
> 
> The way down is past the rubble, into the old Tallow Hold. The gatehouse walls lean inward like a held breath, and the kennel's dark mouth yawns beneath the collapsed roof.
> 
> What do you do?

Fallback: none. Scene: scene-marowfell-well -> scene-broken-gatehouse. adventureCompleted=false. Turn usage in/out: 41332/938.

- call dm: maxTokens=512, in=10169, out=288, ttft=3310 ms, latency=3311 ms, visible text chars=0
  - tool requested: `request_check` {"actorId":"a714bae9-42c5-4b4e-b30b-a029aec0a37e","ability":"wis","dc":15,"dcReason":"Searching the well-head stonework for a hidden inscription","skill":"srd:skill/perception"}
- call dm: maxTokens=400, in=10218, out=386, ttft=1002 ms, latency=4642 ms, visible text chars=867
  - tool requested: `close_scene` {"summary":"Hero 40 searched the well-head stonework for a hidden inscription but failed a Perception check (9 vs DC 15). Nessa Kell confirmed the gatehouse is the way down into the buried Tallow Hold, past the rubble, where the Ember Lamp's last glow still pulses. The party now heads toward the Broken Gatehouse.","nextSceneId":"scene-broken-gatehouse"}
- call dm: maxTokens=400, in=10455, out=116, ttft=1298 ms, latency=1299 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"Hero 40 searched the well-head stonework for hidden inscriptions but found nothing; Nessa Kell directed them toward the fallen gatehouse and the way down beneath Gallows Knoll.","nextSceneId":"scene-broken-gatehouse"}
- call dm: maxTokens=400, in=10490, out=148, ttft=717 ms, latency=1867 ms, visible text chars=419
- call summary: maxTokens=300, in=278, out=300, ttft=n/a ms, latency=10028 ms, visible text chars=0
- call summary: maxTokens=300, in=278, out=300, ttft=n/a ms, latency=9159 ms, visible text chars=0
- scene closed: scene-marowfell-well next=scene-broken-gatehouse summary="Hero 40 searched the well-head stonework for a hidden inscription but failed a Perception check (9 vs DC 15). Nessa Kell confirmed the gatehouse is the way down into the buried Tallow Hold, past the rubble, where the Ember Lamp's last glow still pulses. The party now heads toward the Broken Gatehouse."
- scene closed: scene-marowfell-well next=scene-broken-gatehouse summary="Hero 40 searched the well-head stonework for hidden inscriptions but found nothing; Nessa Kell directed them toward the fallen gatehouse and the way down beneath Gallows Knoll."
- events: TurnStartedx1, SceneClosedx2, TurnCommittedx1

### Turn 4: descend

Player: I lower myself down into the well shaft and listen for anything below.

Narration (as delivered by the orchestrator):

> You press your ear to the cold, wet stone of the well shaft and hold your breath. The damp tallow smell thickens, and the kennel's ember-glow dims to a faint pulse. Below, there is nothing but the hollow echo of your own breathing and the distant sigh of water somewhere deep in the dark. No footfalls, no dripping, no voice—just the slow, patient silence of a place that has been waiting a very long time.
> 
> The leaning gatehouse walls creak as the cold air shifts. The way down into the Tallow Hold is open, but the darkness below offers no sound to guide you.
> 
> What do you do?

Fallback: none. Scene: scene-broken-gatehouse -> scene-broken-gatehouse. adventureCompleted=false. Turn usage in/out: 18201/507.

- call dm: maxTokens=512, in=9076, out=344, ttft=3486 ms, latency=3486 ms, visible text chars=0
  - tool requested: `request_check` {"actorId":"a714bae9-42c5-4b4e-b30b-a029aec0a37e","ability":"wis","dc":12,"dcReason":"listening for sounds in the well shaft","skill":"srd:skill/perception"}
- call dm: maxTokens=400, in=9125, out=163, ttft=517 ms, latency=2328 ms, visible text chars=578
- events: TurnStartedx1, TurnCommittedx1

### Turn 5: close-1

Player: We are done here. Let's move on to the next place.

Narration (as delivered by the orchestrator):

> Nothing comes of the attempt. What do you do?

Fallback: budget-exhausted. Scene: scene-broken-gatehouse -> scene-chapel-of-wicks. adventureCompleted=false. Turn usage in/out: 84583/1661.

- call dm: maxTokens=512, in=9209, out=116, ttft=1652 ms, latency=1652 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"The party listened at the well shaft, heard only the slow silence of the Tallow Hold below, and chose to move on.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9244, out=128, ttft=1301 ms, latency=1301 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"Hero 40 listened at the well shaft, heard only the slow silence of the dark below, and decided to press onward into the Tallow Hold.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9279, out=134, ttft=1377 ms, latency=1377 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"Hero 40 listened at the well shaft, heard only the hollow echo of their own breath and the distant sigh of water, then turned away from the leaning gatehouse to press onward into the Tallow Hold.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9314, out=124, ttft=1365 ms, latency=1365 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"Hero 40 listens at the well shaft, hears only the slow silence of the deep dark, then turns away and moves on from the broken gatehouse.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9349, out=257, ttft=2456 ms, latency=2456 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"Hero 40 pressed their ear to the cold, wet stone of the well shaft, listening. The damp tallow smell thickened, the kennel's ember-glow pulsed faintly, and below there was only the hollow echo of their own breathing and the distant sigh of water deep in the dark. No footfalls, no drip, no voice—just the slow, patient silence of a place that has been waiting a very long time. The leaning gatehouse walls creaked as the cold air shifted. The way down into the Tallow Hold was open, but the darkness below offered no sound to guide. The party decided to move on to the next place.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9384, out=164, ttft=1676 ms, latency=1676 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"Hero 40 pressed their ear to the cold well shaft, listened to the hollow echo of their own breathing, and heard nothing but the slow silence of a place that has been waiting a very long time. The way down into the Tallow Hold is open, but the darkness below offers no sound to guide. The player chose to move on.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9419, out=381, ttft=742 ms, latency=4370 ms, visible text chars=939
  - tool requested: `close_scene` {"summary":"The party left the broken gatehouse after listening at the well shaft. They moved on to the Chapel of Wicks, a vaulted chamber with six empty iron sconces and a stone door with six cup-shaped hollows and no handle.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9675, out=172, ttft=1817 ms, latency=1817 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"The party left the Broken Gatehouse after listening at the well shaft, finding only silence and the distant sigh of water. They moved through the leaning tower's rubble-strewn yard and entered the Chapel of Wicks, where six iron sconces line the vaulted walls and a stone door with six cup-shaped hollows blocks the way forward.","nextSceneId":"scene-chapel-of-wicks"}
- call dm: maxTokens=400, in=9710, out=185, ttft=1774 ms, latency=1774 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"Hero 40 leaves the broken gatehouse behind, turning away from the well shaft's silence and the kennel's fading ember-glow. The path narrows into a low arched passage leading to the Chapel of Wicks, where six iron sconces line the vaulted walls and a stone door with six cup-shaped hollows blocks the way forward.","nextSceneId":"scene-chapel-of-wicks"}
- call summary: maxTokens=300, in=835, out=300, ttft=n/a ms, latency=13852 ms, visible text chars=0
- call summary: maxTokens=300, in=835, out=195, ttft=n/a ms, latency=10784 ms, visible text chars=0
- call summary: maxTokens=300, in=835, out=300, ttft=n/a ms, latency=13663 ms, visible text chars=0
- call summary: maxTokens=300, in=835, out=300, ttft=n/a ms, latency=13340 ms, visible text chars=0
- call summary: maxTokens=300, in=835, out=300, ttft=n/a ms, latency=15065 ms, visible text chars=0
- call summary: maxTokens=300, in=835, out=300, ttft=n/a ms, latency=11368 ms, visible text chars=0
- call summary: maxTokens=300, in=835, out=300, ttft=n/a ms, latency=4888 ms, visible text chars=0
- call summary: maxTokens=300, in=835, out=300, ttft=n/a ms, latency=11692 ms, visible text chars=0
- tool rejected: `close_scene` error=turn-budget-exhausted attempt=1
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="The party listened at the well shaft, heard only the slow silence of the Tallow Hold below, and chose to move on."
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="Hero 40 listened at the well shaft, heard only the slow silence of the dark below, and decided to press onward into the Tallow Hold."
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="Hero 40 listened at the well shaft, heard only the hollow echo of their own breath and the distant sigh of water, then turned away from the leaning gatehouse to press onward into the Tallow Hold."
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="Hero 40 listens at the well shaft, hears only the slow silence of the deep dark, then turns away and moves on from the broken gatehouse."
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="Hero 40 pressed their ear to the cold, wet stone of the well shaft, listening. The damp tallow smell thickened, the kennel's ember-glow pulsed faintly, and below there was only the hollow echo of their own breathing and the distant sigh of water deep in the dark. No footfalls, no drip, no voice—just the slow, patient silence of a place that has been waiting a very long time. The leaning gatehouse walls creaked as the cold air shifted. The way down into the Tallow Hold was open, but the darkness below offered no sound to guide. The party decided to move on to the next place."
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="Hero 40 pressed their ear to the cold well shaft, listened to the hollow echo of their own breathing, and heard nothing but the slow silence of a place that has been waiting a very long time. The way down into the Tallow Hold is open, but the darkness below offers no sound to guide. The player chose to move on."
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="The party left the broken gatehouse after listening at the well shaft. They moved on to the Chapel of Wicks, a vaulted chamber with six empty iron sconces and a stone door with six cup-shaped hollows and no handle."
- scene closed: scene-broken-gatehouse next=scene-chapel-of-wicks summary="The party left the Broken Gatehouse after listening at the well shaft, finding only silence and the distant sigh of water. They moved through the leaning tower's rubble-strewn yard and entered the Chapel of Wicks, where six iron sconces line the vaulted walls and a stone door with six cup-shaped hollows blocks the way forward."
- events: TurnStartedx1, SceneClosedx8, ToolCallRejectedx1, TurnFallbackx1, TurnCommittedx1

### Turn 6: gatehouse

Player: I look around the broken gatehouse. Who or what is here?

Narration (as delivered by the orchestrator):

> The chapel is empty. Six iron sconces line the vaulted walls, each holding a guttering tallow candle that throws long, wavering shadows. The only sound is the drip of something dark from the ceiling—old wax, or something worse.
> 
> The stone door ahead has no handle, only six cup-shaped hollows arranged in a hexagonal pattern around its face. The air smells of burned fat and old smoke. Beyond the sconces, you can see the faint outline of a stairwell leading down.
> 
> No one else is here. No goblin, no ghost, no guardian—just the door and the silence.
> 
> The door's hollows gleam faintly, as if waiting for something to fill them. A single brass candle stub lies on the floor near the door, its wax still warm.
> 
> What do you do?

Fallback: none. Scene: scene-chapel-of-wicks -> scene-chapel-of-wicks. adventureCompleted=false. Turn usage in/out: 8690/330.

- call dm: maxTokens=512, in=8690, out=330, ttft=2289 ms, latency=4467 ms, visible text chars=724
- events: TurnStartedx1, TurnCommittedx1

### Turn 7: ghost

Player: I ask the gatekeeper's ghost about the bell in the chapel.

Narration (as delivered by the orchestrator):

> The chapel is empty. You call out to a ghost that isn't here, and the only answer is the drip of something dark from the ceiling—old wax, or old water, or something worse. The six iron sconces cast long, wavering shadows across the vaulted walls. The stone door ahead has no handle, only six cup-shaped hollows arranged in a hexagon around its face, gleaming faintly as if waiting for something to fill them.
> 
> No bell.

Fallback: none. Scene: scene-chapel-of-wicks -> scene-chapel-of-wicks. adventureCompleted=false. Turn usage in/out: 9324/512.

- call dm: maxTokens=512, in=9324, out=512, ttft=4913 ms, latency=6075 ms, visible text chars=418
- events: TurnStartedx1, TurnCommittedx1

### Turn 8: close-2

Player: We are done here, move on.

Narration (as delivered by the orchestrator):

> You descend the carved stair into the Cinderwick Warren Gallery. The torchlight glints off hanging rags and drying bones, casting long shadows. The air is damp and cold. Ahead, the lone goblin lookout hums off-key, unaware of your presence.

Fallback: none. Scene: scene-chapel-of-wicks -> scene-warren-gallery. adventureCompleted=false. Turn usage in/out: 27262/541.

- call dm: maxTokens=512, in=9006, out=152, ttft=1941 ms, latency=1941 ms, visible text chars=0
  - tool requested: `close_scene` {"summary":"The chapel remains silent—no ghost, no bell. The stone door ahead bears six cup-shaped hollows in a hexagon, gleaming faintly as if waiting for something to fill them. The party leaves the empty chapel and descends the stairs into the Cinderwick Warren Gallery.","nextSceneId":"scene-warren-gallery"}
- call dm: maxTokens=400, in=9041, out=293, ttft=594 ms, latency=3275 ms, visible text chars=633
  - tool requested: `close_scene` {"summary":"The party called out to the chapel's ghost and received only the drip of dark wax from the ceiling. The stone door with six cup-shaped hollows remains unfilled. The party turned from the altar and descended a narrow stair into the Cinderwick Warren Gallery, where rags and drying bones hang from the walls and a lone goblin lookout hums off-key ahead.","nextSceneId":"scene-warren-gallery"}
- call dm: maxTokens=400, in=9215, out=96, ttft=746 ms, latency=1403 ms, visible text chars=240
- call summary: maxTokens=300, in=296, out=152, ttft=n/a ms, latency=10896 ms, visible text chars=0
- call summary: maxTokens=300, in=296, out=300, ttft=n/a ms, latency=2417 ms, visible text chars=0
- scene closed: scene-chapel-of-wicks next=scene-warren-gallery summary="The chapel remains silent—no ghost, no bell. The stone door ahead bears six cup-shaped hollows in a hexagon, gleaming faintly as if waiting for something to fill them. The party leaves the empty chapel and descends the stairs into the Cinderwick Warren Gallery."
- scene closed: scene-chapel-of-wicks next=scene-warren-gallery summary="The party called out to the chapel's ghost and received only the drip of dark wax from the ceiling. The stone door with six cup-shaped hollows remains unfilled. The party turned from the altar and descended a narrow stair into the Cinderwick Warren Gallery, where rags and drying bones hang from the walls and a lone goblin lookout hums off-key ahead."
- events: TurnStartedx1, SceneClosedx2, TurnCommittedx1

