const axios = require("axios");

const concurrentRequests = 75;
const headers = {
  Authorization: "Bearer test",
  "Content-Type": "application/json",
};

const payload = {
  model: "gpt-4",
  max_tokens: 1,
  stream: false,
  messages: [{ role: "user", content: "Hi" }],
};

const makeRequest = async (i) => {
  try {
    const response = await axios.post(
      "http://localhost:7860/proxy/google-ai/v1/chat/completions",
      payload,
      { headers }
    );
    console.log(
      `Req ${i} finished with status code ${response.status} and response:`,
      response.data
    );
  } catch (error) {
    const msg = error.response
    console.error(`Error in req ${i}:`, error.message, msg || "");
  }
};

const executeRequestsConcurrently = () => {
  const promises = [];
  for (let i = 1; i <= concurrentRequests; i++) {
    console.log(`Starting request ${i}`);
    promises.push(makeRequest(i));
  }

  Promise.all(promises).then(() => {
    console.log("All requests finished");
  });
};

executeRequestsConcurrently();
