Case {investigation_id}: review a merchant suspected of collusion or bust-out.

1. Read the case (`get_case`: its type, fields and vocabulary), the brief (`get_brief`) and the material (`list_items`, `read_item`).
2. Find the merchant, its terminals, settlement accounts and partners in the graph (`get_graph`, `search_entities`, `get_entity`); check whether they appeared in other cases (`find_entity_cases`).
3. Run `run_analysis` with kind `links` on phone, account and address, and `communities` to find related merchants; note what you found (`add_note`) and suggest roles from the vocabulary (`annotate`, with the reason).
4. If the type has starter queries, run them (`run_query`) and show the daily volume as a chart (`update_item` with `chart`).
5. Pin what each finding rests on (`pin_evidence`), add follow-ups (`add_task`) and write the brief (`write_brief`).
6. Propose the decision (`propose_decision`) citing the evidence (E1, E2…). A person records it.
