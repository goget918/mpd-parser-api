const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const apiRoutes = require('./src/route/api');
const logger = require('./src/util/logger');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8006;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));

app.use("/api", apiRoutes);

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

