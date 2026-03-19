using System.Runtime.Serialization;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace WorkOS.Organizations
{
    [JsonConverter(typeof(StringEnumConverter))]
    public enum OrganizationStatus
    {
        [EnumMember(Value = "active")]
        Active,

        [EnumMember(Value = "inactive")]
        Inactive,
    }

    [JsonConverter(typeof(StringEnumConverter))]
    public enum Order
    {
        [EnumMember(Value = "asc")]
        Asc,

        [EnumMember(Value = "desc")]
        Desc,
    }

    public class Organization
    {
        [JsonProperty("id")]
        public string Id { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("status")]
        public OrganizationStatus Status { get; set; }

        [JsonProperty("allow_profiles_outside_organization")]
        public bool AllowProfilesOutsideOrganization { get; set; }

        [JsonProperty("domains")]
        public List<string> Domains { get; set; }

        [JsonProperty("created_at")]
        public string CreatedAt { get; set; }

        [JsonProperty("updated_at")]
        public string UpdatedAt { get; set; }
    }

    public class GetOrganizationOptions
    {
        [JsonProperty("organization")]
        public string Organization { get; set; }
    }

    public class ListOrganizationsOptions
    {
        [JsonProperty("limit")]
        public int? Limit { get; set; }

        [JsonProperty("order")]
        public Order? OrderBy { get; set; }

        [JsonProperty("after")]
        public string After { get; set; }
    }

    public class ListOrganizationsResponse
    {
        [JsonProperty("data")]
        public List<Organization> Data { get; set; }

        [JsonProperty("list_metadata")]
        public Common.ListMetadata ListMetadata { get; set; }
    }

    public class CreateOrganizationOptions
    {
        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("domains")]
        public List<string> Domains { get; set; }
    }
}
