import closeWithGrace from 'close-with-grace';
import { buildApp } from './app.js';

const start = async () => {
  const app = await buildApp();

  const closeListeners = closeWithGrace({ delay: 500 }, async ({ err }) => {
    if (err) {
      app.log.error(err, 'Shutting down application due to error');
    }

    await app.close();
  });

  app.addHook('onClose', async () => {
    closeListeners.uninstall();
  });

  try {
    await app.listen({
      port: app.config.PORT,
      host: app.config.HOST,
    });

    app.log.info(
      {
        address: `http://${app.config.HOST}:${app.config.PORT}`,
        environment: app.config.NODE_ENV,
      },
      'Server started',
    );
  } catch (error) {
    app.log.error(error, 'Failed to start server');
    process.exit(1);
  }
};

void start();
