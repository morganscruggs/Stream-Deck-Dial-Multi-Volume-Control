import streamDeck from "@elgato/streamdeck";

import { VolumeControl } from "./actions/volume-control";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// Register the actions.
streamDeck.actions.registerAction(new VolumeControl());

// Finally, connect to the Stream Deck.
streamDeck.connect();
