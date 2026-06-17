# Chbot

## Run tasks

### RUN THIS for development
To run the dev server for your app, use:

```sh
npx nx serve chbot
```

To create a production bundle:

```sh
npx nx build chbot
```

To see all available targets to run for a project, run:

```sh
npx nx show project chbot
```

### In root:
Create `.env` file in root directory with:
```env
TG_API_KEY="***"
TG_PAYMENT_TOKEN="***"
```

