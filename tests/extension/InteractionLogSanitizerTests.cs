using Newtonsoft.Json.Linq;
using VsClineAgent.Host;
using Xunit;

namespace VsClineAgent.Host.Tests
{
    public sealed class InteractionLogSanitizerTests
    {
        [Fact]
        public void RedactsSensitivePropertiesAtEveryDepth()
        {
            var value = new JObject
            {
                ["apiKey"] = "sk-1234567890abcdef",
                ["nested"] = new JObject { ["authorization"] = "Bearer abcdefghijklmnop" }
            };

            var sanitized = InteractionLogSanitizer.Sanitize(value);

            Assert.Equal("sk-1...cdef", sanitized.Value<string>("apiKey"));
            Assert.Equal("Bear...mnop", sanitized["nested"]?.Value<string>("authorization"));
            Assert.Equal("sk-1234567890abcdef", value.Value<string>("apiKey"));
        }

        [Fact]
        public void RedactsSecretPatternsInsideFreeFormText()
        {
            var sanitized = InteractionLogSanitizer.Sanitize("provider failed with sk-proj-abcdefghijklmnop");
            var text = sanitized.Value<string>();

            Assert.DoesNotContain("sk-proj-abcdefghijklmnop", text);
            Assert.Contains("sk-proj...mnop", text);
        }

        [Fact]
        public void BoundsLargeArraysAndStrings()
        {
            var array = new JArray();
            for (var index = 0; index < 60; index++) array.Add(index);
            var sanitizedArray = (JArray)InteractionLogSanitizer.Sanitize(array);
            var sanitizedText = InteractionLogSanitizer.Sanitize(new string('x', 5000)).Value<string>();

            Assert.Equal(51, sanitizedArray.Count);
            Assert.Equal("[truncated 10 items]", sanitizedArray[50]?.Value<string>());
            Assert.Contains("[truncated 904 chars]", sanitizedText);
        }

		[Fact]
		public void RedactsSecretsInsideSerializedStateStrings()
		{
			var value = new JObject
			{
				["stateJson"] = "{\"ollamaApiKey\":\"nvapi-abcdefghijklmnop\"}"
			};

			var sanitized = InteractionLogSanitizer.Sanitize(value).ToString();

			Assert.DoesNotContain("nvapi-abcdefghijklmnop", sanitized);
			Assert.Contains("nvap...mnop", sanitized);
		}
    }
}
