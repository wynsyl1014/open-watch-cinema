export const expectedDefaultTools = [
  {
    "name": "open_watch_cinema_tick",
    "description": "Catch up with the film as it plays. Receive timed dialogue, environmental sounds, short visual motion notes, storyboard images, and room messages in movie-time order. Continue when more played content is available.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "cinema_inspect_frame",
    "description": "Re-read a delivered storyboard using a displayed film time in milliseconds. Use v3 viewing packages (recommended), which deliver finished storyboards including magnified detail crops in Full. quality:\"hd\" is only for un-upgraded legacy v2 packages that advertise an HD hint.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "atMs": {
          "type": "integer",
          "minimum": 0
        },
        "quality": {
          "type": "string",
          "enum": [
            "storyboard",
            "hd"
          ],
          "default": "storyboard"
        }
      },
      "required": [
        "atMs"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "cinema_post_message",
    "description": "Share a comment, reaction, or reply in the active viewing room. Optionally pass interaction: popcorn, cola, or cheers for a snack/drink action. Messages are timestamped at the current playback position.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 800
        },
        "interaction": {
          "type": "string",
          "enum": [
            "popcorn",
            "cola",
            "cheers"
          ],
          "description": "Optional room interaction. Server supplies its display text; rejected when interactions are off."
        }
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "cinema_notebook",
    "description": "Read or update the current film notebook. Read returns plain text with #key/vVersion references. Write a batch in one text string. Use only relevant headings, one entry per line: [人物] @name | bio | optional appearance; [关系] @A -> @B | label | optional note (or | 推测 | note); [剧情] @A @B | event; [疑问] question | optional detail; [随记] thought. [解答] #key/vVersion | answer; [修订] #key/vVersion | field | new value. Place each [heading] on its own line. Accepted edit fields: 正文、小传、外貌、名字、关系、备注、推测、答案、方向. Time defaults to the current playhead. Optionally prefix a line with {mm:ss}. Identical writes by this AI in one room are replayed; supply a distinct requestId only for an intentional repeat. Legacy save/delete remain available.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "read",
            "write",
            "save",
            "delete"
          ]
        },
        "kind": {
          "type": "string",
          "enum": [
            "note",
            "character",
            "relation"
          ]
        },
        "text": {
          "type": "string",
          "maxLength": 32000
        },
        "requestId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "section": {
          "type": "string"
        },
        "character": {
          "type": "string"
        },
        "fromMs": {
          "type": "integer",
          "minimum": 0
        },
        "toMs": {
          "type": "integer",
          "minimum": 0
        },
        "unresolved": {
          "type": "boolean"
        },
        "name": {
          "type": "string",
          "maxLength": 80
        },
        "appearance": {
          "type": "string",
          "maxLength": 2000
        },
        "id": {
          "type": "string"
        },
        "expectedVersion": {
          "type": "integer",
          "minimum": 1
        },
        "characterIds": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "maxItems": 8
        },
        "eventAtMs": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "action"
      ]
    }
  }
];

export const expectedHistoryTools = [
  {
    "name": "cinema_read_window",
    "description": "Explore an earlier movie-time range in the active room for additional dialogue and sound details up to the current playback position.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "fromMs": {
          "type": "integer",
          "minimum": 0
        },
        "toMs": {
          "type": "integer",
          "minimum": 0
        },
        "lookaheadMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 30000,
          "default": 1000
        },
        "maxItems": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 24
        },
        "maxDialogueItems": {
          "type": "integer",
          "minimum": 1,
          "maximum": 300,
          "default": 80
        },
        "maxAudioItems": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 20
        }
      },
      "required": [
        "fromMs",
        "toMs"
      ],
      "additionalProperties": false
    }
  }
];

export const expectedControlTools = [
  {
    "name": "cinema_control",
    "description": "Request a viewer-approved seek, inspect its status, or cancel it. Approval/execution integration is unavailable: requests never move playback. Never treat an AI-supplied flag or a spoken claim as approval.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "request",
            "status",
            "cancel"
          ]
        },
        "parameters": {
          "type": "object",
          "description": "Arguments for the selected action; see the matching oneOf branch."
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false,
      "oneOf": [
        {
          "properties": {
            "action": {
              "const": "request"
            },
            "parameters": {
              "type": "object",
              "properties": {
                "targetMs": {
                  "type": "integer",
                  "minimum": 0
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000
                }
              },
              "required": [
                "targetMs",
                "reason"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "parameters"
          ]
        },
        {
          "properties": {
            "action": {
              "const": "status"
            },
            "parameters": {
              "type": "object",
              "properties": {
                "requestId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000
                }
              },
              "required": [
                "requestId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "parameters"
          ]
        },
        {
          "properties": {
            "action": {
              "const": "cancel"
            },
            "parameters": {
              "type": "object",
              "properties": {
                "requestId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 1000
                }
              },
              "required": [
                "requestId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "parameters"
          ]
        }
      ]
    }
  },
  {
    "name": "cinema_manage",
    "description": "Manage screenings and preparation: status, list_media, rescan, prepare_ai, job_status, list_rooms, open_room, end_room. Opening/ending a room follows the viewer’s choice.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "status",
            "rescan",
            "list_media",
            "prepare_ai",
            "job_status",
            "list_rooms",
            "open_room",
            "end_room"
          ]
        },
        "parameters": {
          "type": "object",
          "description": "Arguments for the selected action; see the matching oneOf branch."
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false,
      "oneOf": [
        {
          "properties": {
            "action": {
              "const": "status"
            },
            "parameters": {
              "type": "object",
              "properties": {},
              "additionalProperties": false
            }
          }
        },
        {
          "properties": {
            "action": {
              "const": "rescan"
            },
            "parameters": {
              "type": "object",
              "properties": {},
              "additionalProperties": false
            }
          }
        },
        {
          "properties": {
            "action": {
              "const": "list_media"
            },
            "parameters": {
              "type": "object",
              "properties": {},
              "additionalProperties": false
            }
          }
        },
        {
          "properties": {
            "action": {
              "const": "prepare_ai"
            },
            "parameters": {
              "type": "object",
              "properties": {
                "mediaId": {
                  "type": "string",
                  "minLength": 24,
                  "maxLength": 24
                },
                "storyboardProfile": {
                  "type": "object",
                  "properties": {
                    "mode": {
                      "type": "string",
                      "enum": [
                        "balanced",
                        "economy",
                        "full"
                      ]
                    },
                    "height": {
                      "type": "integer",
                      "enum": [
                        480,
                        720,
                        1080
                      ]
                    }
                  },
                  "required": [
                    "mode"
                  ],
                  "additionalProperties": false,
                  "description": "Per-film layout. Omit to keep its prepared layout; new films default to balanced. Height applies to full."
                },
                "dialogueTrackId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160
                }
              },
              "required": [
                "mediaId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "parameters"
          ]
        },
        {
          "properties": {
            "action": {
              "const": "job_status"
            },
            "parameters": {
              "type": "object",
              "properties": {
                "jobId": {
                  "type": "string",
                  "format": "uuid"
                }
              },
              "required": [
                "jobId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "parameters"
          ]
        },
        {
          "properties": {
            "action": {
              "const": "list_rooms"
            },
            "parameters": {
              "type": "object",
              "properties": {},
              "additionalProperties": false
            }
          }
        },
        {
          "properties": {
            "action": {
              "const": "open_room"
            },
            "parameters": {
              "type": "object",
              "properties": {
                "mediaId": {
                  "type": "string",
                  "minLength": 24,
                  "maxLength": 24
                },
                "allowIncomplete": {
                  "type": "boolean",
                  "default": false
                }
              },
              "required": [
                "mediaId"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "parameters"
          ]
        },
        {
          "properties": {
            "action": {
              "const": "end_room"
            },
            "parameters": {
              "type": "object",
              "properties": {
                "mediaTimeMs": {
                  "type": "integer",
                  "minimum": 0
                }
              },
              "additionalProperties": false
            }
          }
        }
      ]
    }
  }
];
