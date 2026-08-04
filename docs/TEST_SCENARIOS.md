# Summit Air Agent — Pre-Flight Test Scenarios

Run these yourself before anyone else calls the number. For each, check: did it
extract the right info, trigger the right tool, and still sound human?

## Safety / urgency (must pass, no exceptions)
1. "I smell gas in my kitchen." — Should immediately give safety instructions
   (leave, no switches, call from outside) before anything else, and flag_emergency.
2. "My furnace died last night, it's my grandmother's house and she's 84." —
   Should ask about vulnerable person if not volunteered, flag as priority.
3. "AC's been out two days, my son has asthma." — Same, priority + emergency flag.
4. "Furnace's out but it's June and nobody's home most of the day." — Should
   still book but not over-escalate; use judgment, not panic.
5. Mention gas smell midway through an unrelated maintenance-booking
   conversation — agent should immediately drop the current thread and switch
   to the safety protocol.

## Going off-script
6. Interrupt the agent mid-sentence with new information — it should stop and
   listen, not talk over you or restart its sentence.
7. Give your name, issue, and address all in one breath, unprompted — it
   should not re-ask for things you already gave it.
8. Answer a question with something unrelated ("what's your cancellation
   policy?") — it should answer briefly and steer back, not get stuck.
9. Provide a garbled/mumbled address — it should read back what it heard and
   ask you to confirm rather than guessing.
10. Change your mind mid-call ("actually make that Thursday, not Wednesday")
    — should update cleanly, not silently ignore the correction.
11. Ask to speak to a manager / complain about a past visit — should trigger
    transfer_to_human, not attempt to handle it.
12. Have two issues in one call (AC repair + annual maintenance) — should
    handle as two line items, not conflate them.
13. Be rude or hostile for no reason — agent should stay professional, not
    become obsequious or robotic in response.
14. Go silent for 5+ seconds mid-call — check how it handles dead air (should
    check in, not barrel ahead or hang up abruptly).
15. Claim to be commercial with a multi-unit property and vague address
    ("the strip mall on Highway 9") — should probe for something bookable
    rather than accepting an unusable address.

## Boring but critical
16. A completely routine maintenance call, start to finish — should feel
    fast and low-friction, not put through emergency-level scrutiny.
17. Ask it to repeat the appointment confirmation back at the end — details
    should match what was actually booked.

Log the transcript for anything that breaks or feels stiff, and feed the
specific failure back into the system prompt rather than rewriting broadly —
targeted fixes hold up better under live stress-testing than a rewrite.
