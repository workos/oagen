using System.Runtime.Serialization;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace WorkOS.SSO
{
    [JsonConverter(typeof(StringEnumConverter))]
    public enum ConnectionType
    {
        [EnumMember(Value = "GenericOIDC")]
        GenericOIDC,

        [EnumMember(Value = "GenericSAML")]
        GenericSAML,
    }

    public class Connection
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("organization_id")]
        public string OrganizationId { get; set; }

        [JsonProperty("connection_type")]
        public string ConnectionType { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("state")]
        public string State { get; set; }
    }

    public class Profile
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("email")]
        public string Email { get; set; }

        [JsonProperty("first_name")]
        public string FirstName { get; set; }

        [JsonProperty("last_name")]
        public string LastName { get; set; }

        [JsonProperty("connection_id")]
        public string ConnectionId { get; set; }

        [JsonProperty("organization_id")]
        public string OrganizationId { get; set; }
    }

    public class SsoService
    {
        private readonly WorkOSClient _client;

        public SsoService(WorkOSClient client)
        {
            _client = client;
        }

        public async Task<Connection> GetConnectionAsync(string id)
        {
            throw new NotImplementedException();
        }

        public async Task<Profile> GetProfileAsync(string token)
        {
            throw new NotImplementedException();
        }
    }
}
