import streamDeck from "@elgato/streamdeck";

import { VolumeControl } from "./actions/volume-control";

// Switch to "trace" while debugging to record every message between Stream Deck and the plugin.
streamDeck.logger.setLevel("info");

// Register the actions.
streamDeck.actions.registerAction(new VolumeControl());

// Finally, connect to the Stream Deck.
streamDeck.connect();
