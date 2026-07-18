const flow = {
  "version": "6.3",
  "data_api_version": "3.0",
  "routing_model": {
    "PIN_SCREEN": ["SUCCESS"]
  },
  "screens": [
    {
      "id": "PIN_SCREEN",
      "title": "Approve Transaction",
      "data": {},
      "layout": {
        "type": "SingleColumnLayout",
        "children": [
          {
            "type": "TextBody",
            "text": "Enter your 4-digit GuildPay transaction PIN to approve this transfer. Your PIN is never shown in the chat."
          },
          {
            "type": "Form",
            "name": "pin_form",
            "children": [
              {
                "type": "TextInput",
                "name": "pin",
                "label": "Transaction PIN",
                "input-type": "passcode",
                "required": true,
                "min-chars": 4,
                "max-chars": 4,
                "helper-text": "4 digits"
              },
              {
                "type": "Footer",
                "label": "Approve Transaction",
                "on-click-action": {
                  "name": "data_exchange",
                  "payload": {
                    "pin": "${form.pin}"
                  }
                }
              }
            ]
          }
        ]
      }
    }
  ]
};
console.log("Syntax is valid JSON:", JSON.stringify(flow) !== "");
