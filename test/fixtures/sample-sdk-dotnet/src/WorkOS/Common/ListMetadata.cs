using Newtonsoft.Json;

namespace WorkOS.Common
{
    public class ListMetadata
    {
        [JsonProperty("before")]
        public string Before { get; set; }

        [JsonProperty("after")]
        public string After { get; set; }
    }
}
