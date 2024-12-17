# TBD-Voice-Agnet

This is a dedicated monorepo for the unilux voice agent and beyond.

### Running Locally

1. Install Preqrequisites

- pnpm via `brew install pnpm`
- NODE JS >= 18.18.2
- Prettier and ESlint VS Code extensions

2. Install Dependencies

```
pnpm install
```

3. Update Prisma

`npx prisma db pull` to pull the latest schema from the database
`npx prisma generate` to update the prisma client with the latest changes

4. Look at the sample .env file and create your own .env file with the correct values

5. run `ngrok http 3000` to get a public url for your local server

6. login to twilio and update the webhook url for the twiml voice-agent-dev app [here](https://console.twilio.com/us1/develop/phone-numbers/manage/twiml-apps?frameUrl=%2Fconsole%2Fvoice%2Ftwiml%2Fapps%2FAPcb1e8b340616c3cee1a908ebe025b4ba%3F__override_layout__%3Dembed%26bifrost%3Dtrue%26x-target-region%3Dus1)

7. login to retell and update the custom llm url for the local agent [here](https://beta.retellai.com/dashboard/agents?agent=4f0fbb106ba5d4673c9e5eb937ecded5)

8. run `pnpm dev` to start the server

### Commands

- `pnpm dev` runs the server in development mode
- `pnpm build` builds the server
- `pnpm start` runs the server in production mode
- `pnpm add <package>` adds a package
- `pnpm tsx ...path_to_file` runs a typescript file, good for adhoc testing

### Database Commands

1. Make sure the `DATABASE_URL` secret is set in your .env file. For the love of god make sure it's the STAGING connection uri and not the prod one. The staging one should contain the words "orange-sea".

2. Make your changes in the Retool DB ui as you normally would

3. Pull the latest staging schema by running `npx prisma db pull` in the terminal. This will update the schema.prisma file with the latest changes from the database.

4. Run `npx prisma generate` to update the prisma client with the latest changes.

5. Make a PR for the changes. Make sure to include the schema.prisma file in the PR. This is important because the schema.prisma file is the record of changes for the database schema. This is so we can keep each other informed of changes to the database schema.

6. Once the PR is merged and updated + the feature youre building is all hunky dorey in staging, then you can go to Retool DB, hit schema migration and update prod.

### Troubleshooting

If you ran `npm install` by accident, delete your `node_modules` folder and run `pnpm install` again.
If you installed something using `npm install packageA`, run `npm uninstall packageA`, delete the `package-lock.json` and then `pnpm add packageA` to install the package using pnpm.

### Manual Test Cases

1. Happy path.

- `category = PROPOSED_BOOKING` `status = PENDING_REVIEW`
- PII is captured
- appointed foreign key
- email is sent to leo@fieldtrainer via webhook
- transcript and details are legible in the email and in the UI

2. Leave a message. This should be `category = OTHER` and `status = PENDING_REVIEW`

- same as above but
- call reason is captured

3. User talks a little - then abrupt hang up `category = ABRUPT_HANGUP` `status = AUTO_CLOSED`

4. Make sure you can't book the same slot more then the number of tech available. Ex. if Jose and Cuong at both available from 9-10, you should only be able to have 2 appointments at that time.

### Todos for Template

- [ ] add common folder and logging
- [ ] routes, controllers, services, models
- [ ] recommended eslint settings
- [ ] preferred vs code settings?
- [ ] testing setup
- [ ] clerk, prisma, tailwind... am I just making t3 again..
